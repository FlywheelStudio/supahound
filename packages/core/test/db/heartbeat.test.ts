import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import { pollHealth } from "../../src/db/heartbeat.js";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import type { LogsQuery } from "../../src/logs/client.js";
import { ownershipFromColumns } from "../../src/ownership/ownership.js";
import { runHeartbeat } from "../../src/poller/heartbeat.js";
import { pollProject, type OutgoingEmail, type PollDeps } from "../../src/poller/pollProject.js";
import { projectScope, tenantId, type ProjectScope } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

// Issue #133: the staff heartbeat's cross-tenant read and the customer log gap.

const NOW = new Date("2026-10-27T12:30:00Z");
const REF = "abcdefghijklmnopqrst";

describe.skipIf(pgInfo === null)("poller heartbeat and log gap", () => {
  const db = useDb();
  let a: ProjectScope;
  let b: ProjectScope;

  async function onboard(name: string): Promise<ProjectScope> {
    const t = tenantId(randomUUID());
    return withTenant(db.app, t, async (tx) => {
      await repo.createTenant(tx, name);
      const conn = await repo.createConnection(tx, db.vault, { label: name, token: `token-${randomUUID()}` });
      const p = await repo.createProject(tx, { connectionId: conn, supabaseRef: REF, name });
      await repo.setOwnership(tx, p, ownershipFromColumns({ notes: ["user_id"] }));
      return projectScope(t, p);
    });
  }

  // A finished run, written as the admin so tests can place it in time.
  async function run(s: ProjectScope, finishedAt: Date, status: "ok" | "unable_to_assess", edgeRequests: number | null = null) {
    await db.admin.query(
      `INSERT INTO supahound.poll_runs (tenant_id, project_id, window_start, window_end, status, started_at, finished_at, edge_requests)
       VALUES ($1, $2, $3, $4, $5, $3, $4, $6)`,
      [s.tenantId, s.projectId, new Date(finishedAt.getTime() - 60_000), finishedAt, status, edgeRequests],
    );
  }

  beforeEach(async () => {
    await db.admin.query("DELETE FROM supahound.poll_runs");
    a = await onboard("Agency");
    b = await onboard("Client");
  });

  describe("pollHealth (scheduler role)", () => {
    it("aggregates finished runs per minute across every tenant", async () => {
      await run(a, new Date("2026-10-27T11:00:10Z"), "ok");
      await run(a, new Date("2026-10-27T12:10:10Z"), "ok");
      await run(b, new Date("2026-10-27T12:10:40Z"), "unable_to_assess");
      await run(b, new Date("2026-10-27T12:12:00Z"), "ok");
      const h = await pollHealth(db.scheduler, new Date("2026-10-27T12:00:00Z"), new Date("2026-10-27T12:12:00Z"));
      expect(h.lastBefore).toEqual(new Date("2026-10-27T11:00:10Z"));
      // The 12:12:00 run is at `until`, so outside the range.
      expect(h.buckets).toEqual([
        { minute: Date.parse("2026-10-27T12:10:00Z") / 60_000, total: 2, unable: 1, last: new Date("2026-10-27T12:10:40Z") },
      ]);
    });

    it("emails staff once when polling stops while projects are due", async () => {
      await run(a, new Date("2026-10-27T12:09:30Z"), "ok");
      const sent: OutgoingEmail[] = [];
      const deps = {
        scheduler: db.scheduler, billing: "off" as const, staffEmail: "ops@example.com",
        send: async (m: OutgoingEmail) => { sent.push(m); },
        from: { email: "alerts@example.com", name: "Supahound alerts" }, appUrl: "https://app.example",
      };
      // 12:00 UTC starts a 6-hour slot. 12:24: 14.5 minutes since the last finish; 12:25: 15.5.
      expect(await runHeartbeat(deps, new Date("2026-10-27T12:24:00Z"))).toEqual({ status: "healthy" });
      expect(await runHeartbeat(deps, new Date("2026-10-27T12:25:00Z"))).toEqual({ status: "sent", sent: 1, failed: 0 });
      expect(await runHeartbeat(deps, new Date("2026-10-27T12:26:00Z"))).toEqual({ status: "throttled" });
      expect(sent.map((m) => m.to)).toEqual(["ops@example.com"]);
      // No tenant, project or ref in the email.
      const body = sent[0]!.text + sent[0]!.html;
      for (const banned of [a.tenantId, a.projectId, REF, "Agency"]) expect(body).not.toContain(banned);
    });

    it("issue #159: of the two crons, only the web cron's stale check emails a stopped poller", async () => {
      await run(a, new Date("2026-10-27T12:09:30Z"), "ok");
      const sent: string[] = [];
      const deps = (checks: "stale" | "failing") => ({
        scheduler: db.scheduler, billing: "off" as const, staffEmail: "ops@example.com",
        send: async () => { sent.push(checks); },
        from: { email: "alerts@example.com", name: "Supahound alerts" }, appUrl: "https://app.example",
        checks,
      });
      for (let m = 20; m < 40; m++) {
        const now = new Date(Date.parse("2026-10-27T12:00:00Z") + m * 60_000);
        await runHeartbeat(deps("failing"), now);
        await runHeartbeat(deps("stale"), now);
      }
      expect(sent).toEqual(["stale"]);
    });
  });

  describe("log gap", () => {
    const summary = async (s: ProjectScope) =>
      withTenant(db.app, s.tenantId, async (tx) => (await repo.listProjects(tx)).find((p) => p.id === s.projectId)!);
    const minute = (n: number) => new Date(NOW.getTime() - (repo.LOG_GAP_WINDOWS + 10 - n) * 60_000);

    it("shows after LOG_GAP_WINDOWS zero-request windows that follow traffic, and not before", async () => {
      await run(a, minute(0), "ok", 25);
      for (let i = 1; i < repo.LOG_GAP_WINDOWS; i++) await run(a, minute(i), "ok", 0);
      expect((await summary(a)).logGap).toBe(false);
      await run(a, minute(repo.LOG_GAP_WINDOWS), "ok", 0);
      expect((await summary(a)).logGap).toBe(true);
      // Traffic again clears it; the other tenant never saw it.
      await run(a, minute(repo.LOG_GAP_WINDOWS + 1), "ok", 3);
      expect((await summary(a)).logGap).toBe(false);
      expect((await summary(b)).logGap).toBe(false);
    });

    it("never shows for a project that has had no traffic at all, or whose windows were not counted", async () => {
      for (let i = 0; i <= repo.LOG_GAP_WINDOWS; i++) await run(a, minute(i), "ok", 0);
      expect((await summary(a)).logGap).toBe(false);
      await run(b, minute(0), "ok", 25);
      for (let i = 1; i <= repo.LOG_GAP_WINDOWS; i++) await run(b, minute(i), "ok", null);
      expect((await summary(b)).logGap).toBe(false);
    });

    it("stores each poll window's request count beside the rollup, audited before it runs", async () => {
      const queries: string[] = [];
      const deps: PollDeps = {
        app: db.app, vault: db.vault, now: () => NOW, countRequests: true,
        queryLogs: async (q: LogsQuery) => {
          queries.push(q.sql);
          return /count\(\) AS requests/.test(q.sql) ? [{ requests: "42" }] : [];
        },
        queryPolicies: async () => { throw new Error("ownership was hand-set"); },
        explain: async () => { throw new Error("no incidents expected"); },
      };
      expect(await pollProject(a, deps)).toMatchObject({ status: "ok" });
      // The rollup, the request count and, because the rollup came back empty, the auth-coverage count (#130).
      expect(queries).toHaveLength(3);
      expect(queries.filter((q) => /count\(\) AS requests/.test(q))).toHaveLength(1);
      const rows = await withTenant(db.app, a.tenantId, (tx) => tx.query<{ edge_requests: string }>("SELECT edge_requests FROM supahound.poll_runs"));
      expect(rows.map((r) => Number(r.edge_requests))).toEqual([42]);
      const audit = await withTenant(db.app, a.tenantId, (tx) =>
        tx.query<{ detail: Record<string, unknown> }>("SELECT detail FROM supahound.audit_log WHERE action = 'logs_query'"),
      );
      // One audit row for the rollup (it carries the count's hash) and one for the coverage count.
      expect(audit).toHaveLength(2);
      expect(audit.find((r) => r.detail.count_sql_sha256)!.detail.count_sql_sha256).toMatch(/^[0-9a-f]{64}$/);
    });

    it("keeps the poll when the count fails, with the count unknown", async () => {
      const deps: PollDeps = {
        app: db.app, vault: db.vault, now: () => NOW, countRequests: true,
        queryLogs: async (q: LogsQuery) => {
          if (/count\(\) AS requests/.test(q.sql)) throw new Error("rate limited");
          return [];
        },
        queryPolicies: async () => { throw new Error("ownership was hand-set"); },
        explain: async () => { throw new Error("no incidents expected"); },
      };
      expect(await pollProject(a, deps)).toMatchObject({ status: "ok" });
      const rows = await withTenant(db.app, a.tenantId, (tx) => tx.query<{ status: string; edge_requests: string | null }>("SELECT status, edge_requests FROM supahound.poll_runs"));
      expect(rows).toEqual([{ status: "ok", edge_requests: null }]);
    });
  });
});
