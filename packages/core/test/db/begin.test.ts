import { describe, expect, it } from "vitest";
import { begin } from "../../src/db/tenant.js";
import { pgInfo, useDb } from "./harness.js";

// begin() opens the transaction and sets every GUC in one round trip, with escaped literals
// instead of $n parameters. These tests pin the three things that make that safe.
describe.skipIf(pgInfo === null)("begin: one round trip", () => {
  const db = useDb();

  async function inTx<T>(settings: Record<string, string>, fn: (q: (sql: string) => Promise<unknown>) => Promise<T>): Promise<T> {
    const client = await db.app.connect();
    try {
      await begin(client, settings);
      const result = await fn(async (sql) => (await client.query(sql)).rows[0]);
      await client.query("ROLLBACK");
      return result;
    } finally {
      client.release();
    }
  }

  it("sets every value exactly, quotes and backslashes included", async () => {
    const hostile = `x'); SELECT set_config('app.tenant_id', 'evil', true); --\\`;
    const got = await inTx({ "app.tenant_id": "t-1", "app.user_id": hostile }, (q) =>
      q("SELECT current_setting('app.tenant_id') AS t, current_setting('app.user_id') AS u"),
    );
    expect(got).toEqual({ t: "t-1", u: hostile });
  });

  it("rejects a setting name outside app.*", async () => {
    const client = await db.app.connect();
    try {
      await expect(begin(client, { "app.x', 'y', true); --": "v" })).rejects.toThrow(/Invalid setting name/);
      await expect(begin(client, { "search_path": "public" })).rejects.toThrow(/Invalid setting name/);
    } finally {
      client.release();
    }
  });

  it("keeps the settings transaction-local", async () => {
    const client = await db.app.connect();
    try {
      await begin(client, { "app.tenant_id": "scoped" });
      await client.query("COMMIT");
      const after = await client.query("SELECT current_setting('app.tenant_id', true) AS t");
      expect(after.rows[0].t ?? "").toBe("");
    } finally {
      client.release();
    }
  });
});
