import { createHash, randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import type { ExplainResult } from "../../src/explainer/llm.js";
import { templateExplanation } from "../../src/explainer/template.js";
import { SqlQueryError } from "../../src/ownership/client.js";
import { ownershipFromColumns, POLICIES_SQL } from "../../src/ownership/ownership.js";
import { OWNERSHIP_REFRESH_SECONDS, OWNERSHIP_RETRY_SECONDS, pollProject, type PollDeps } from "../../src/poller/pollProject.js";
import { projectScope, tenantId, type ProjectScope } from "../../src/tenancy/scope.js";
import { ALICE, BOB, CHROME_UA } from "../helpers.js";
import { pgInfo, useDb } from "./harness.js";

// Ownership refresh inside the poll (issue #10, decision 024), against Postgres under forced RLS.
// Supabase's logs and read-only SQL endpoints are fakes. Synthetic data only.

const REF = "abcdefghijklmnopqrst";
const T0 = new Date("2026-11-10T12:30:00Z");
const after = (seconds: number) => new Date(T0.getTime() + seconds * 1000);

// Alice reads Bob's notes (detector 2) and the service key is used from a browser (detector 4).
const rows = (now: Date) => {
  const seen = new Date(now.getTime() - 200_000).toISOString();
  return [
    {
      method: "GET", path: "/rest/v1/notes", search: `?user_id=eq.${BOB}`, status: "200", contentRange: "0-49/*",
      userAgent: "python-httpx/0.28.1", asn: "14061", asOrganization: "DigitalOcean, LLC",
      jwtSubject: ALICE, jwtRole: "authenticated", apiKeyRole: "anon", hits: "37", first_seen: seen, last_seen: seen,
    },
    {
      method: "GET", path: "/rest/v1/notes", search: "?select=*", status: "200", contentRange: "0-99/*",
      userAgent: CHROME_UA, asn: "7922", asOrganization: "Comcast", jwtRole: "service_role", apiKeyRole: "service_role",
      hits: "2", first_seen: seen, last_seen: seen,
    },
  ];
};

const NOTES_POLICY = { schemaname: "public", tablename: "notes", permissive: "PERMISSIVE", roles: ["authenticated"], cmd: "ALL", qual: "(auth.uid() = user_id)" };
const MEMBERSHIP_POLICY = {
  schemaname: "public", tablename: "notes", permissive: "PERMISSIVE", roles: ["authenticated"], cmd: "ALL",
  qual: "(team_id IN ( SELECT m.team_id FROM members m WHERE (m.user_id = auth.uid())))",
};

describe.skipIf(pgInfo === null)("ownership refresh in the poll", () => {
  const db = useDb();
  let policyCalls: { ref: string; sql: string; token: string; auditedFirst: boolean; at: Date }[];
  let policies: () => Record<string, unknown>[];

  async function watch(name: string): Promise<ProjectScope> {
    const t = tenantId(randomUUID());
    return withTenant(db.app, t, async (tx) => {
      await repo.createTenant(tx, name);
      const conn = await repo.createConnection(tx, db.vault, { label: name, token: `token-${randomUUID()}` });
      return projectScope(t, await repo.createProject(tx, { connectionId: conn, supabaseRef: REF, name }));
    });
  }

  const audit = (s: ProjectScope) => withTenant(db.app, s.tenantId, (tx) =>
    tx.query<{ action: string; detail: Record<string, unknown> }>("SELECT action, detail FROM supahound.audit_log ORDER BY created_at, action"));
  const project = (s: ProjectScope) => withTenant(db.app, s.tenantId, (tx) => repo.getProject(tx, s.projectId));
  const summary = async (s: ProjectScope) => (await withTenant(db.app, s.tenantId, (tx) => repo.listProjects(tx)))[0]!;
  const lastRun = (s: ProjectScope) => withTenant(db.app, s.tenantId, async (tx) =>
    (await tx.query<{ status: string; unassessed_detectors: string[] }>(
      "SELECT status, unassessed_detectors FROM supahound.poll_runs ORDER BY started_at DESC LIMIT 1"))[0]!);
  const detectors = (s: ProjectScope) => withTenant(db.app, s.tenantId, async (tx) =>
    (await tx.query<{ detector: string }>("SELECT DISTINCT detector FROM supahound.findings ORDER BY detector")).map((r) => r.detector));

  function poll(s: ProjectScope, now: Date) {
    const deps: PollDeps = {
      app: db.app, vault: db.vault, now: () => now, intervalSeconds: 0,
      queryLogs: async () => rows(now),
      queryPolicies: async (q, o) => {
        const audited = await db.admin.query(
          "SELECT 1 FROM supahound.audit_log WHERE tenant_id = $1 AND project_id = $2 AND action = 'policies_query' AND created_at >= now() - interval '5 seconds'",
          [s.tenantId, s.projectId],
        );
        policyCalls.push({ ref: q.projectRef, sql: q.sql, token: o.token, auditedFirst: audited.rows.length > 0, at: now });
        return policies();
      },
      explain: async (f): Promise<ExplainResult> =>
        ({ explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] }),
    };
    return pollProject(s, deps);
  }

  beforeEach(() => {
    policyCalls = [];
    policies = () => [NOTES_POLICY];
  });

  it("reads the policies on the first poll, audits the query before it runs, and detector 2 uses them", async () => {
    const s = await watch("Notes app");
    expect(await poll(s, T0)).toMatchObject({ status: "ok", findings: 2 });

    expect(policyCalls).toHaveLength(1);
    expect(policyCalls[0]).toMatchObject({ ref: REF, sql: POLICIES_SQL, auditedFirst: true });
    expect(policyCalls[0]!.sql).toMatch(/FROM pg_catalog\.pg_policies/);
    const policyAudit = (await audit(s)).filter((a) => a.action === "policies_query");
    expect(policyAudit).toEqual([{ action: "policies_query", detail: { sql_sha256: createHash("sha256").update(POLICIES_SQL).digest("hex") } }]);

    expect(await project(s)).toMatchObject({
      ownership: { notes: { SELECT: ["user_id"], UPDATE: ["user_id"], DELETE: ["user_id"] } },
      ownershipRefreshedAt: T0, ownershipError: null,
    });
    expect(await detectors(s)).toEqual(["cross_tenant", "service_role_misuse"]);
    expect(await lastRun(s)).toEqual({ status: "ok", unassessed_detectors: [] });
    expect((await summary(s)).crossTenant).toBe("assessed");
  });

  it("reads 'unable to assess' for detector 2 when the policies never loaded, and detector 4 still alerts", async () => {
    const s = await watch("Locked app");
    policies = () => { throw new SqlQueryError("forbidden", 403); };
    expect(await poll(s, T0)).toMatchObject({ status: "ok", findings: 1 });

    expect(await detectors(s)).toEqual(["service_role_misuse"]);
    expect(await lastRun(s)).toEqual({ status: "ok", unassessed_detectors: ["cross_tenant"] });
    expect(await project(s)).toMatchObject({ ownershipRefreshedAt: null, ownershipError: "unauthorized" });
    expect(await summary(s)).toMatchObject({ lastRunStatus: "ok", crossTenant: "unable_to_assess" });
  });

  it("keeps the last good ownership when a later read fails", async () => {
    const s = await watch("Notes app");
    await withTenant(db.app, s.tenantId, (tx) => repo.setOwnership(tx, s.projectId, ownershipFromColumns({ notes: ["user_id"] }), after(-OWNERSHIP_REFRESH_SECONDS - 60)));
    policies = () => { throw new SqlQueryError("bad gateway", 502); };
    expect(await poll(s, T0)).toMatchObject({ status: "ok", findings: 2 });

    expect(policyCalls).toHaveLength(1);
    expect(await project(s)).toMatchObject({ ownership: { notes: { SELECT: ["user_id"] } }, ownershipError: "query_failed" });
    expect(await lastRun(s)).toEqual({ status: "ok", unassessed_detectors: [] });
  });

  it("reads again after 24 hours, not before", async () => {
    const s = await watch("Notes app");
    await poll(s, T0);
    await poll(s, after(60));
    await poll(s, after(OWNERSHIP_REFRESH_SECONDS - 60));
    expect(policyCalls).toHaveLength(1);
    await poll(s, after(OWNERSHIP_REFRESH_SECONDS));
    expect(policyCalls.map((c) => c.at)).toEqual([T0, after(OWNERSHIP_REFRESH_SECONDS)]);
  });

  it("retries a failed read after an hour instead of on every poll", async () => {
    const s = await watch("Flaky app");
    policies = () => { throw new SqlQueryError("rate limited", 429); };
    await poll(s, T0);
    await poll(s, after(OWNERSHIP_RETRY_SECONDS - 60));
    expect(policyCalls).toHaveLength(1);
    expect((await project(s))!.ownershipError).toBe("rate_limited");

    policies = () => [NOTES_POLICY];
    await poll(s, after(OWNERSHIP_RETRY_SECONDS));
    expect(policyCalls).toHaveLength(2);
    expect(await project(s)).toMatchObject({ ownershipError: null, ownershipRefreshedAt: after(OWNERSHIP_RETRY_SECONDS) });
  });

  it("retries after an hour when an attempt never saved (worker lost mid-read)", async () => {
    const s = await watch("Lost app");
    await db.admin.query("UPDATE supahound.projects SET ownership_attempted_at = $1 WHERE tenant_id = $2", [T0, s.tenantId]);
    await poll(s, after(OWNERSHIP_RETRY_SECONDS - 60));
    expect(policyCalls).toHaveLength(0);
    await poll(s, after(OWNERSHIP_RETRY_SECONDS + 60));
    expect(policyCalls).toHaveLength(1);
    expect((await project(s))!.ownershipRefreshedAt).toEqual(after(OWNERSHIP_RETRY_SECONDS + 60));
  });

  it("tells 'no owner-scoped tables' apart from clean and from unable to assess", async () => {
    const s = await watch("Team app");
    policies = () => [MEMBERSHIP_POLICY];
    expect(await poll(s, T0)).toMatchObject({ status: "ok", findings: 1 });
    expect(await project(s)).toMatchObject({ ownership: {}, ownershipRefreshedAt: T0 });
    expect(await lastRun(s)).toEqual({ status: "ok", unassessed_detectors: [] });
    expect((await summary(s)).crossTenant).toBe("no_owned_tables");
  });

  it("stores an unreadable response as invalid_response, never as an empty map", async () => {
    const s = await watch("Odd app");
    policies = () => { throw new SqlQueryError("no row array", 201); };
    await poll(s, T0);
    expect(await project(s)).toMatchObject({ ownership: {}, ownershipRefreshedAt: null, ownershipError: "invalid_response" });
    expect((await summary(s)).crossTenant).toBe("unable_to_assess");
  });

  it("writes no policies_query row and reads nothing when the token will not open", async () => {
    const s = await watch("Broken app");
    const other = await watch("Other app");
    await db.admin.query(
      "UPDATE supahound.connections SET sealed_token = (SELECT sealed_token FROM supahound.connections WHERE tenant_id = $1) WHERE tenant_id = $2",
      [other.tenantId, s.tenantId],
    );
    expect(await poll(s, T0)).toEqual({ status: "unable_to_assess", errorCode: "token_unavailable" });
    expect(policyCalls).toEqual([]);
    expect((await audit(s)).map((a) => a.action)).toEqual(["logs_query"]);
  });

  it("refreshes one tenant's project without touching another tenant's copy of the same Supabase project", async () => {
    const agency = await watch("Agency");
    const client = await watch("Client");
    await poll(agency, T0);
    expect((await project(agency))!.ownershipRefreshedAt).toEqual(T0);
    expect(await project(client)).toMatchObject({ ownership: {}, ownershipRefreshedAt: null, ownershipAttemptedAt: null });
    expect(await audit(client)).toEqual([]);
    expect(policyCalls.map((c) => c.token)).toHaveLength(1);
  });

  it("rejects a detector name the schema does not know", async () => {
    const s = await watch("Notes app");
    const runId = await withTenant(db.app, s.tenantId, (tx) => repo.startPollRun(tx, s.projectId, { start: T0, end: after(60) }));
    await expect(
      withTenant(db.app, s.tenantId, (tx) => tx.query("UPDATE supahound.poll_runs SET unassessed_detectors = '{everything}' WHERE id = $1", [runId])),
    ).rejects.toThrow(/check constraint/);
  });
});
