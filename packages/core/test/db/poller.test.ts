import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import type { IncidentFeatures } from "../../src/explainer/features.js";
import type { ExplainResult } from "../../src/explainer/llm.js";
import { templateExplanation } from "../../src/explainer/template.js";
import { LogsApiError, type LogsQuery } from "../../src/logs/client.js";
import { ownershipFromColumns } from "../../src/ownership/ownership.js";
import { FIRST_LOOKBACK_MINUTES, LAG_SECONDS, pollProject, type PollDeps } from "../../src/poller/pollProject.js";
import { runDuePolls } from "../../src/poller/scheduler.js";
import { projectScope, tenantId, type ProjectScope } from "../../src/tenancy/scope.js";
import { ALICE, BOB, CHROME_UA } from "../helpers.js";
import { pgInfo, useDb } from "./harness.js";

const SHARED_REF = "zyxwvutsrqponmlkjihg";
const NOW = new Date("2026-10-27T12:30:00Z");

const attackRows = [
  {
    method: "GET", path: "/rest/v1/notes", search: `?user_id=eq.${BOB}`, status: "200", contentRange: "0-49/*",
    userAgent: "python-httpx/0.28.1", asn: "14061", asOrganization: "DigitalOcean, LLC",
    jwtSubject: ALICE, jwtRole: "authenticated", apiKeyRole: "anon", hits: "37",
    first_seen: "2026-10-27T12:27:00Z", last_seen: "2026-10-27T12:28:00Z",
  },
  {
    method: "GET", path: "/rest/v1/notes", search: "?select=*", status: "200", contentRange: "0-99/*",
    userAgent: CHROME_UA, asn: "7922", asOrganization: "Comcast", jwtRole: "service_role", apiKeyRole: "service_role",
    hits: "2", first_seen: "2026-10-27T12:27:30Z", last_seen: "2026-10-27T12:27:40Z",
  },
];
const benignRows = [
  {
    method: "GET", path: "/rest/v1/notes", search: `?user_id=eq.${BOB}`, status: "200", contentRange: "0-9/*",
    jwtSubject: BOB, jwtRole: "authenticated", apiKeyRole: "anon", hits: "12",
    first_seen: "2026-10-27T12:27:00Z", last_seen: "2026-10-27T12:28:00Z",
  },
  {
    method: "GET", path: "/rest/v1/notes", search: "?select=*", status: "200", contentRange: "0-99/*",
    userAgent: "node", clientInfo: "supabase-js-node/2.80.0", asn: "16509", asOrganization: "Amazon.com, Inc.",
    jwtRole: "service_role", apiKeyRole: "service_role", hits: "60",
    first_seen: "2026-10-27T12:27:00Z", last_seen: "2026-10-27T12:28:00Z",
  },
];

describe.skipIf(pgInfo === null)("poller across tenants", () => {
  const db = useDb();
  let agency: ProjectScope;
  let client: ProjectScope;
  let logCalls: { token: string; ref: string; start: Date; end: Date }[];
  let explained: IncidentFeatures[];
  const behaviour: Record<string, (q: LogsQuery) => Record<string, unknown>[]> = {};

  async function onboard(name: string, token: string): Promise<ProjectScope> {
    const t = tenantId(randomUUID());
    return withTenant(db.app, t, async (tx) => {
      await repo.createTenant(tx, name);
      const conn = await repo.createConnection(tx, db.vault, { label: name, token });
      const p = await repo.createProject(tx, { connectionId: conn, supabaseRef: SHARED_REF, name });
      await repo.setOwnership(tx, p, ownershipFromColumns({ notes: ["user_id"] }));
      return projectScope(t, p);
    });
  }

  function deps(over: Partial<PollDeps> = {}): PollDeps {
    return {
      app: db.app,
      vault: db.vault,
      now: () => NOW,
      queryLogs: async (q: LogsQuery, o: { token: string }) => {
        logCalls.push({ token: o.token, ref: q.projectRef, start: q.start, end: q.end });
        return behaviour[o.token]!(q);
      },
      explain: async (f: IncidentFeatures): Promise<ExplainResult> => {
        explained.push(f);
        return { explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] };
      },
      ...over,
    };
  }

  beforeEach(async () => {
    agency = await onboard("Agency", `agency-token-${randomUUID()}`);
    client = await onboard("Client", `client-token-${randomUUID()}`);
    logCalls = [];
    explained = [];
  });

  const tokenOf = (s: ProjectScope) =>
    withTenant(db.app, s.tenantId, async (tx) => repo.openConnectionToken(tx, db.vault, (await repo.getProject(tx, s.projectId))!.connectionId));

  it("polls each tenant with its own token and keeps results apart", async () => {
    behaviour[await tokenOf(agency)] = () => attackRows;
    behaviour[await tokenOf(client)] = () => benignRows;

    expect(await pollProject(agency, deps())).toMatchObject({ status: "ok", findings: 2, notified: 2 });
    expect(await pollProject(client, deps())).toMatchObject({ status: "ok", findings: 0, notified: 0 });
    expect(logCalls.map((c) => c.token)).toEqual([await tokenOf(agency), await tokenOf(client)]);

    const agencyIncidents = await withTenant(db.app, agency.tenantId, (tx) => repo.openIncidents(tx, agency.projectId));
    const clientIncidents = await withTenant(db.app, client.tenantId, (tx) => repo.openIncidents(tx, client.projectId));
    expect(agencyIncidents.map((i) => i.severity).sort()).toEqual(["critical", "critical"]);
    expect(clientIncidents).toEqual([]);

    // The client's server traffic taught the client's memory only.
    const nets = async (s: ProjectScope) => withTenant(db.app, s.tenantId, (tx) => repo.loadNetworks(tx, s.projectId));
    expect(await nets(client)).toEqual([16509]);
    expect(await nets(agency)).toEqual([]);
  });

  it("gives the model no IDs, refs, tokens or user agents", async () => {
    const token = await tokenOf(agency);
    behaviour[token] = () => attackRows;
    await pollProject(agency, deps());
    const text = JSON.stringify(explained);
    expect(explained).toHaveLength(2);
    for (const banned of [ALICE, BOB, SHARED_REF, token, agency.tenantId, agency.projectId, "Mozilla", "python-httpx", "Agency"]) {
      expect(text).not.toContain(banned);
    }
  });

  it("audits the logs query before it runs and every model call with ZDR requested", async () => {
    behaviour[await tokenOf(agency)] = () => attackRows;
    await pollProject(agency, deps());
    const audit = await withTenant(db.app, agency.tenantId, (tx) =>
      tx.query<{ action: string; detail: Record<string, unknown> }>("SELECT action, detail FROM guardbase.audit_log ORDER BY created_at"),
    );
    expect(audit.map((a) => a.action)).toEqual(["logs_query", "model_call", "model_call"]);
    expect(audit[0]!.detail.sql_sha256).toMatch(/^[0-9a-f]{64}$/);
    for (const a of audit.slice(1)) expect(a.detail.zero_data_retention_requested).toBe(true);
    const clientAudit = await withTenant(db.app, client.tenantId, (tx) => tx.query("SELECT 1 FROM guardbase.audit_log"));
    expect(clientAudit).toEqual([]);
  });

  it("reports unable to assess on a Supabase failure, never an all-clear, without touching other tenants", async () => {
    behaviour[await tokenOf(agency)] = () => attackRows;
    behaviour[await tokenOf(client)] = () => { throw new LogsApiError("rate limited", 429); };
    const results = await runDuePolls({ ...deps(), scheduler: db.scheduler, concurrency: 2 });
    const byTenant = Object.fromEntries(results.map((r) => [r.scope.tenantId, r.outcome]));
    expect(byTenant[agency.tenantId]).toMatchObject({ status: "ok" });
    expect(byTenant[client.tenantId]).toEqual({ status: "unable_to_assess", errorCode: "rate_limited" });
    const runs = await withTenant(db.app, client.tenantId, (tx) =>
      tx.query<{ status: string; error_code: string }>("SELECT status, error_code FROM guardbase.poll_runs"),
    );
    expect(runs).toEqual([{ status: "unable_to_assess", error_code: "rate_limited" }]);
  });

  it("keeps findings and still alerts with template text when the explainer throws", async () => {
    behaviour[await tokenOf(agency)] = () => attackRows;
    const r = await pollProject(agency, deps({ explain: async () => { throw new Error("model exploded"); } }));
    expect(r).toMatchObject({ status: "ok", findings: 2, notified: 2 });
    const incidents = await withTenant(db.app, agency.tenantId, (tx) =>
      tx.query<{ summary_source: string }>("SELECT summary_source FROM guardbase.incidents"),
    );
    expect(incidents.map((i) => i.summary_source)).toEqual(["template", "template"]);
    const audit = await withTenant(db.app, agency.tenantId, (tx) =>
      tx.query<{ action: string }>("SELECT action FROM guardbase.audit_log WHERE action = 'model_call'"),
    );
    expect(audit).toHaveLength(2);
  });

  it("contains a crash to the project that crashed", async () => {
    behaviour[await tokenOf(agency)] = () => null as unknown as Record<string, unknown>[];
    behaviour[await tokenOf(client)] = () => benignRows;
    const results = await runDuePolls({ ...deps(), scheduler: db.scheduler });
    const byTenant = Object.fromEntries(results.map((r) => [r.scope.tenantId, r.outcome.status]));
    expect(byTenant[agency.tenantId]).toBe("crashed");
    expect(byTenant[client.tenantId]).toBe("ok");
  });

  describe("windows", () => {
    const later = (s: number) => new Date(NOW.getTime() + s * 1000);
    const minute = (d: Date) => d.getTime() % 60_000 === 0;

    it("reads contiguous, minute-aligned windows that never overlap", async () => {
      behaviour[await tokenOf(agency)] = () => [];
      await pollProject(agency, deps({ now: () => NOW }));
      await pollProject(agency, deps({ now: () => later(60) }));
      const [w1, w2] = logCalls;
      expect(w1!.end.getTime()).toBe(Math.floor((NOW.getTime() - LAG_SECONDS * 1000) / 60_000) * 60_000);
      expect(w1!.end.getTime() - w1!.start.getTime()).toBe(FIRST_LOOKBACK_MINUTES * 60_000);
      expect(w2!.start).toEqual(w1!.end);
      expect([w1!.start, w1!.end, w2!.start, w2!.end].every(minute)).toBe(true);
    });

    it("counts each request once across consecutive polls", async () => {
      // A fake Supabase that returns only the rows inside the requested window.
      const timed = [-200, -150, -100, -40, -10].map((offset) => ({
        ...attackRows[0], hits: "5",
        first_seen: later(offset).toISOString(), last_seen: later(offset).toISOString(),
      }));
      behaviour[await tokenOf(agency)] = (q) =>
        timed.filter((r) => Date.parse(r.first_seen) >= q.start.getTime() && Date.parse(r.first_seen) < q.end.getTime());
      await pollProject(agency, deps({ now: () => NOW }));
      await pollProject(agency, deps({ now: () => later(60) }));
      await pollProject(agency, deps({ now: () => later(180) }));
      const incidents = await withTenant(db.app, agency.tenantId, (tx) => repo.openIncidents(tx, agency.projectId));
      expect(incidents).toHaveLength(1);
      expect(incidents[0]!.hits).toBe(25);
      expect(incidents[0]!.findingCount).toBe(5);
    });

    it("covers a failed poll's span on the next good poll", async () => {
      let fail = false;
      behaviour[await tokenOf(agency)] = () => { if (fail) throw new LogsApiError("boom", 503); return []; };
      await pollProject(agency, deps({ now: () => NOW }));
      fail = true;
      expect(await pollProject(agency, deps({ now: () => later(60) }))).toMatchObject({ status: "unable_to_assess" });
      fail = false;
      await pollProject(agency, deps({ now: () => later(120) }));
      expect(logCalls[2]!.start).toEqual(logCalls[0]!.end);
      expect(logCalls[2]!.end.getTime()).toBeGreaterThan(logCalls[1]!.end.getTime());
    });

    it("skips when nothing new has landed since the last window", async () => {
      behaviour[await tokenOf(agency)] = () => [];
      await pollProject(agency, deps({ now: () => NOW }));
      expect(await pollProject(agency, deps({ now: () => NOW, intervalSeconds: 0 }))).toEqual({ status: "skipped", reason: "nothing_new" });
    });
  });

  it("marks a run left in running by a lost worker as unable to assess", async () => {
    behaviour[await tokenOf(agency)] = () => [];
    await withTenant(db.app, agency.tenantId, (tx) =>
      repo.startPollRun(tx, agency.projectId, { start: new Date(NOW.getTime() - 3_600_000), end: new Date(NOW.getTime() - 3_000_000) }),
    );
    await db.admin.query("UPDATE guardbase.poll_runs SET started_at = $1 WHERE tenant_id = $2", [new Date(NOW.getTime() - 3_600_000), agency.tenantId]);
    await pollProject(agency, deps());
    const runs = await withTenant(db.app, agency.tenantId, (tx) =>
      tx.query<{ status: string; error_code: string | null }>("SELECT status, error_code FROM guardbase.poll_runs ORDER BY started_at"),
    );
    expect(runs).toEqual([
      { status: "unable_to_assess", error_code: "worker_lost" },
      { status: "ok", error_code: null },
    ]);
  });

  it("lets exactly one of two racing workers poll a project", async () => {
    behaviour[await tokenOf(agency)] = () => attackRows;
    const results = await Promise.all([pollProject(agency, deps()), pollProject(agency, deps())]);
    expect(results.map((r) => r.status).sort()).toEqual(["ok", "skipped"]);
    expect(results.find((r) => r.status === "skipped")).toEqual({ status: "skipped", reason: "claimed_elsewhere" });
    expect(logCalls).toHaveLength(1);
  });

  it("skips projects polled within the interval", async () => {
    behaviour[await tokenOf(agency)] = () => [];
    behaviour[await tokenOf(client)] = () => [];
    const first = await runDuePolls({ ...deps({ now: () => new Date() }), scheduler: db.scheduler });
    const mine = (r: typeof first) => r.filter((x) => [agency.tenantId, client.tenantId].includes(x.scope.tenantId));
    expect(mine(first)).toHaveLength(2);
    const second = await runDuePolls({ ...deps({ now: () => new Date() }), scheduler: db.scheduler });
    expect(mine(second)).toHaveLength(0);
  });

  it("reports a token that will not open as unable to assess", async () => {
    await db.admin.query(
      "UPDATE guardbase.connections SET sealed_token = (SELECT sealed_token FROM guardbase.connections WHERE tenant_id = $1) WHERE tenant_id = $2",
      [agency.tenantId, client.tenantId],
    );
    expect(await pollProject(client, deps())).toEqual({ status: "unable_to_assess", errorCode: "token_unavailable" });
    expect(logCalls).toEqual([]);
  });
});
