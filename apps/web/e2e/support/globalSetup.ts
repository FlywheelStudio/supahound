import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { startFakeAuth } from "./fakeAuth";
import { startFakeManagement } from "./fakeManagement";
import { startPostgres } from "./postgres";

// Starts the whole E2E stack: Postgres 17 (TCP) → fake Supabase Auth and Management API → the BUILT web Worker
// under `wrangler dev`. Run `vite build` first (`pnpm e2e` does). Tests read connection details
// from process.env, which Playwright passes on to its workers.

export const APP_PORT = Number(process.env.E2E_APP_PORT ?? 8790);
export const APP_URL = `http://127.0.0.1:${APP_PORT}`;

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const srv = createServer();
    srv.listen(0, "127.0.0.1", () => {
      const { port } = srv.address() as { port: number };
      srv.close(() => resolve(port));
    });
    srv.on("error", reject);
  });
}

async function waitFor(url: string, child: ChildProcess, log: () => string, timeoutMs = 60_000): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (child.exitCode !== null) throw new Error(`wrangler dev exited (${child.exitCode}):\n${log()}`);
    try {
      const res = await fetch(url, { redirect: "manual" });
      if (res.status < 500) return;
    } catch {
      // not listening yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  throw new Error(`Timed out waiting for ${url}:\n${log()}`);
}

export default async function globalSetup(): Promise<() => Promise<void>> {
  const pg = await startPostgres(await freePort());
  const auth = await startFakeAuth(await freePort(), APP_URL);
  const mgmt = await startFakeManagement(await freePort());
  const masterKeys = `1:${randomBytes(32).toString("base64")}`;

  // Test-only values, written to a temp file outside the repo and deleted on teardown.
  const dir = mkdtempSync(join(tmpdir(), "supahound-e2e-"));
  const envFile = join(dir, "e2e.env");
  writeFileSync(envFile, [
    `APP_URL=${APP_URL}`,
    `SUPABASE_URL=${auth.url}`,
    "SUPABASE_PUBLISHABLE_KEY=sb_publishable_e2e",
    "SUPABASE_OAUTH_CLIENT_ID=e2e-oauth-client",
    `SUPABASE_API_URL=${mgmt.url}`,
    `SEND_EMAIL_HOOK_SECRET=${auth.hookSecret}`,
    "SUPABASE_OAUTH_CLIENT_SECRET=e2e-oauth-secret",
    `SUPAHOUND_MASTER_KEYS=${masterKeys}`,
    "EMAIL_FROM_ADDRESS=login@supahound.test",
  ].join("\n"));

  const webDir = fileURLToPath(new URL("../../", import.meta.url));
  let output = "";
  const wrangler = spawn(
    "pnpm",
    ["exec", "wrangler", "dev", "--config", "dist/server/wrangler.json", "--ip", "127.0.0.1", "--port", String(APP_PORT),
      "--inspector-port", String(await freePort()), "--env-file", envFile, "--show-interactive-dev-session=false"],
    {
      cwd: webDir,
      env: {
        ...process.env,
        CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP: pg.appUrl,
        WRANGLER_SEND_METRICS: "false",
      },
      stdio: ["ignore", "pipe", "pipe"],
    },
  );
  wrangler.stdout?.on("data", (d) => (output += String(d)));
  wrangler.stderr?.on("data", (d) => (output += String(d)));

  try {
    await waitFor(`${APP_URL}/login`, wrangler, () => output);
  } catch (err) {
    wrangler.kill();
    await auth.stop();
    await mgmt.stop();
    pg.stop();
    throw err;
  }

  process.env.E2E_APP_URL = APP_URL;
  process.env.E2E_AUTH_URL = auth.url;
  process.env.E2E_MGMT_URL = mgmt.url;
  process.env.E2E_ADMIN_DB_URL = pg.adminUrl;
  process.env.E2E_APP_DB_URL = pg.appUrl;
  process.env.E2E_MASTER_KEYS = masterKeys;
  if (process.env.E2E_DEBUG) process.stdout.write(output);

  return async () => {
    wrangler.kill("SIGTERM");
    await new Promise((r) => setTimeout(r, 500));
    if (wrangler.exitCode === null) wrangler.kill("SIGKILL");
    await auth.stop();
    await mgmt.stop();
    pg.stop();
    rmSync(dir, { recursive: true, force: true });
    if (process.env.E2E_DEBUG) process.stdout.write(output);
  };
}
