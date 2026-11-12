import { randomUUID } from "node:crypto";
import pg from "pg";
import { describe, expect, it } from "vitest";
import { runSubprocessorNotice } from "../../src/cli.js";
import { createWorkspace } from "../../src/db/user.js";
import { noticeRecipients } from "../../src/notices/subprocessor.js";
import { verifiedUserId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

// The subprocessor notice's recipients (decision 037), read through supahound_notifier.

describe.skipIf(pgInfo === null)("subprocessor notice recipients", () => {
  const db = useDb();

  it("lists each owner address once across workspaces, never admins or members, and counts owners with no address", async () => {
    const owner = verifiedUserId(randomUUID());
    const a = await createWorkspace(db.app, owner, "Notice A", "Owner@Example.com");
    await createWorkspace(db.app, owner, "Notice B", "owner@example.com");
    await createWorkspace(db.app, verifiedUserId(randomUUID()), "Notice C", "second@example.com");
    await createWorkspace(db.app, verifiedUserId(randomUUID()), "Notice D", null);
    await db.admin.query(
      "INSERT INTO supahound.memberships (tenant_id, user_id, role, email) VALUES ($1, $2, 'admin', 'admin@example.com'), ($1, $3, 'member', 'member@example.com')",
      [a, randomUUID(), randomUUID()],
    );
    expect(await noticeRecipients(db.notifier)).toEqual({ addresses: ["owner@example.com", "second@example.com"], ownersWithoutAddress: 1 });
  });

  it("dry run through the CLI: prints counts only, never an address, and sends nothing", async () => {
    const lines: string[] = [];
    let fetched = 0;
    const info = pgInfo!;
    const code = await runSubprocessorNotice(
      ["--name", "Twilio", "--purpose", "SMS alerts", "--location", "United States", "--effective", "2027-03-01", "--contact", "hello@example.com"],
      {
        env: { SUPAHOUND_NOTIFIER_DATABASE_URL: "set", CLOUDFLARE_ACCOUNT_ID: "acc", CLOUDFLARE_EMAIL_API_TOKEN: "tok", NOTICE_FROM_ADDRESS: "n@example.com" },
        today: new Date("2026-11-12T00:00:00Z"),
        notifier: () => {
          const name = (db.notifier as unknown as { options: { database: string } }).options.database;
          return new pg.Pool({ host: info.host, port: info.port, database: name, user: "notifier_user", max: 1 });
        },
        fetch: (async () => { fetched++; return new Response("{}"); }) as typeof fetch,
        readJournal: () => [],
        appendJournal: () => undefined,
        out: (l) => lines.push(l),
      },
    );
    expect(code).toBe(0);
    expect(fetched).toBe(0);
    expect(lines[0]).toMatch(/^\d+ recipients/);
    expect(lines.join("\n")).toContain("Dry run: nothing was sent");
    expect(lines.join("\n")).not.toMatch(/@/);
  });
});
