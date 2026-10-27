import { existsSync } from "node:fs";
import { pathToFileURL } from "node:url";
import pg from "pg";
import { explainIncident } from "./explainer/llm.js";
import { queryLogs } from "./logs/client.js";
import { runDuePolls } from "./poller/scheduler.js";
import { TokenVault } from "./vault/vault.js";

// Long-running poller. Two database logins, one per role:
//   DATABASE_URL            member of guardbase_app (tenant data, through withTenant only)
//   SCHEDULER_DATABASE_URL  member of guardbase_scheduler (project IDs only)
// GUARDBASE_MASTER_KEYS seals and opens OAuth tokens; AI_GATEWAY_API_KEY reaches the gateway,
// where every call carries zero data retention (src/explainer/llm.ts).

function required(name: string): string {
  const v = process.env[name];
  if (!v) throw new Error(`${name} is not set`);
  return v;
}

export async function main(): Promise<void> {
  if (existsSync(".env")) process.loadEnvFile(".env");
  const app = new pg.Pool({ connectionString: required("DATABASE_URL"), max: 10 });
  const scheduler = new pg.Pool({ connectionString: required("SCHEDULER_DATABASE_URL"), max: 2 });
  const vault = TokenVault.fromEnv();
  const apiKey = required("AI_GATEWAY_API_KEY");
  const tickMs = Number(process.env.GUARDBASE_TICK_SECONDS ?? 15) * 1000;

  let stopping = false;
  const stop = () => { stopping = true; };
  process.on("SIGINT", stop);
  process.on("SIGTERM", stop);

  while (!stopping) {
    const started = Date.now();
    const results = await runDuePolls({
      app, scheduler, vault,
      queryLogs,
      explain: (features) => explainIncident(features, { apiKey }),
    }).catch(() => []);
    // Counts only: no scope IDs, refs or error text in logs.
    const tally = results.reduce<Record<string, number>>((t, r) => ({ ...t, [r.outcome.status]: (t[r.outcome.status] ?? 0) + 1 }), {});
    process.stdout.write(`${new Date().toISOString()} polled ${results.length} ${JSON.stringify(tally)}\n`);
    await new Promise((r) => setTimeout(r, Math.max(0, tickMs - (Date.now() - started))));
  }
  await Promise.all([app.end(), scheduler.end()]);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    process.stderr.write(`${err instanceof Error ? err.message : "worker failed"}\n`);
    process.exit(1);
  });
}
