import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import type { IncidentFeatures } from "../../src/explainer/features.js";
import type { ExplainResult } from "../../src/explainer/llm.js";
import { templateExplanation } from "../../src/explainer/template.js";
import { LogsApiError, type LogsQuery } from "../../src/logs/client.js";
import { ROLLUP_LIMIT } from "../../src/logs/sql.js";
import { SqlQueryError } from "../../src/ownership/client.js";
import { ownershipFromColumns } from "../../src/ownership/ownership.js";
import { pollProject, type PollDeps } from "../../src/poller/pollProject.js";
import { projectScope, tenantId, type ProjectScope } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "../db/harness.js";
import { ALICE, BOB, CHROME_UA } from "../helpers.js";

// User acceptance scenarios for detection (docs/testing.md, UAT-D*). Each scenario reads as the
// PRD states the outcome, and runs the whole poll: logs rollup → detectors → incident engine →
// explainer → Postgres under forced RLS. Only Supabase's logs API and the model are replaced.
// Synthetic data only.

const T0 = new Date("2026-11-09T12:30:00Z");
const at = (secondsFromT0: number) => new Date(T0.getTime() + secondsFromT0 * 1000);

// Rollup rows as the logs query returns them. `seen` places them inside the poll window.
function row(seen: Date, fields: Record<string, string>): Record<string, unknown> {
  return { status: "200", contentRange: "0-49/*", first_seen: seen.toISOString(), last_seen: seen.toISOString(), ...fields };
}
const scrape = (seen: Date, hits = "37") => row(seen, {
  method: "GET", path: "/rest/v1/notes", search: `?user_id=eq.${BOB}`, userAgent: "python-httpx/0.28.1",
  asn: "14061", asOrganization: "DigitalOcean, LLC", jwtSubject: ALICE, jwtRole: "authenticated", apiKeyRole: "anon", hits,
});
const serviceKeyFromBrowser = (seen: Date) => row(seen, {
  method: "GET", path: "/rest/v1/notes", search: "?select=*", userAgent: CHROME_UA, asn: "7922", asOrganization: "Comcast",
  jwtRole: "service_role", apiKeyRole: "service_role", hits: "2",
});
const normalTraffic = (seen: Date) => [
  row(seen, {
    method: "GET", path: "/rest/v1/notes", search: `?user_id=eq.${BOB}`, userAgent: CHROME_UA, clientInfo: "supabase-js-web/2.80.0",
    asn: "7922", asOrganization: "Comcast", jwtSubject: BOB, jwtRole: "authenticated", apiKeyRole: "anon", hits: "120",
  }),
  row(seen, {
    method: "GET", path: "/rest/v1/notes", search: "?select=*", userAgent: "node", clientInfo: "supabase-js-node/2.80.0",
    asn: "16509", asOrganization: "Amazon.com, Inc.", jwtRole: "service_role", apiKeyRole: "service_role", hits: "60",
  }),
];

describe.skipIf(pgInfo === null)("UAT: detection", () => {
  const db = useDb();
  // `q` is the window Supabase was asked for; most scenarios place every row inside it.
  let logs: (now: Date, q: LogsQuery) => Record<string, unknown>[];
  // The project's pg_policies rows, read through the read-only SQL endpoint. Only projects that
  // start without a hand-set map (pickProject) read them.
  let policies: () => Record<string, unknown>[];

  async function watchProject(name: string, supabaseRef = "abcdefghijklmnopqrst"): Promise<ProjectScope> {
    const t = tenantId(randomUUID());
    return withTenant(db.app, t, async (tx) => {
      await repo.createTenant(tx, name);
      const conn = await repo.createConnection(tx, db.vault, { label: name, token: `token-${randomUUID()}` });
      const p = await repo.createProject(tx, { connectionId: conn, supabaseRef, name });
      await repo.setOwnership(tx, p, ownershipFromColumns({ notes: ["user_id"] }));
      return projectScope(t, p);
    });
  }

  // As the project picker leaves a project: no ownership yet. The first poll reads the policies.
  async function pickProject(name: string): Promise<ProjectScope> {
    const t = tenantId(randomUUID());
    return withTenant(db.app, t, async (tx) => {
      await repo.createTenant(tx, name);
      const conn = await repo.createConnection(tx, db.vault, { label: name, token: `token-${randomUUID()}` });
      return projectScope(t, await repo.createProject(tx, { connectionId: conn, supabaseRef: "abcdefghijklmnopqrst", name }));
    });
  }

  function poll(scope: ProjectScope, now: Date, extra: Partial<PollDeps> = {}) {
    const deps: PollDeps = {
      app: db.app, vault: db.vault, now: () => now, intervalSeconds: 0,
      queryLogs: async (q) => logs(now, q),
      queryPolicies: async () => policies(),
      explain: async (f: IncidentFeatures): Promise<ExplainResult> =>
        ({ explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] }),
      ...extra,
    };
    return pollProject(scope, deps);
  }

  const dashboard = (s: ProjectScope) => withTenant(db.app, s.tenantId, (tx) => repo.listOpenIncidents(tx));
  const projects = (s: ProjectScope) => withTenant(db.app, s.tenantId, (tx) => repo.listProjects(tx));

  beforeEach(() => {
    logs = () => [];
    policies = () => { throw new Error("queryPolicies called: ownership was hand-set"); };
  });

  it("UAT-D1 a user who reads another user's rows raises one critical incident and one page", async () => {
    const s = await watchProject("Notes app");
    logs = (now) => [scrape(new Date(now.getTime() - 200_000))];
    expect(await poll(s, T0)).toMatchObject({ status: "ok", findings: 1, notified: 1 });

    const open = await dashboard(s);
    expect(open).toHaveLength(1);
    expect(open[0]).toMatchObject({ severity: "critical", projectName: "Notes app", hits: 37 });
    expect(open[0]!.summary?.summary).toBeTruthy();
  });

  it("UAT-D2 the service key used from a browser on a home network raises a critical incident", async () => {
    const s = await watchProject("Billing app");
    logs = (now) => [serviceKeyFromBrowser(new Date(now.getTime() - 200_000))];
    expect(await poll(s, T0)).toMatchObject({ status: "ok", findings: 1, notified: 1 });
    expect((await dashboard(s)).map((i) => i.severity)).toEqual(["critical"]);
  });

  it("UAT-D3 normal app and server traffic raises nothing and the project reads as assessed", async () => {
    const s = await watchProject("Quiet app");
    logs = (now) => normalTraffic(new Date(now.getTime() - 200_000));
    expect(await poll(s, T0)).toMatchObject({ status: "ok", findings: 0, notified: 0 });
    expect(await dashboard(s)).toEqual([]);
    expect((await projects(s))[0]).toMatchObject({ lastRunStatus: "ok", openIncidents: 0 });
  });

  it("UAT-D4 the same attack minutes later updates the open incident and does not page again", async () => {
    const s = await watchProject("Notes app");
    logs = (now) => [scrape(new Date(now.getTime() - 130_000), "10")];
    expect(await poll(s, T0)).toMatchObject({ notified: 1 });
    expect(await poll(s, at(60))).toMatchObject({ status: "ok", findings: 1, notified: 0 });
    expect(await poll(s, at(120))).toMatchObject({ status: "ok", findings: 1, notified: 0 });

    const open = await dashboard(s);
    expect(open).toHaveLength(1);
    expect(open[0]!.hits).toBe(30);
  });

  it("UAT-D5 a Supabase logs outage reads as 'unable to assess', never as an all-clear", async () => {
    const s = await watchProject("Outage app");
    logs = () => { throw new LogsApiError("log ingestion down", 503); };
    expect(await poll(s, T0)).toMatchObject({ status: "unable_to_assess" });
    expect((await projects(s))[0]!.lastRunStatus).toBe("unable_to_assess");
    expect(await dashboard(s)).toEqual([]);
  });

  it("UAT-D6 an agency and its client watching one Supabase project each see only their own incidents", async () => {
    const agency = await watchProject("Agency", "sharedrefsharedrefxx");
    const client = await watchProject("Client", "sharedrefsharedrefxx");
    logs = (now) => [scrape(new Date(now.getTime() - 200_000))];
    await poll(agency, T0);
    logs = (now) => normalTraffic(new Date(now.getTime() - 200_000));
    await poll(client, T0);

    expect((await dashboard(agency)).map((i) => i.projectName)).toEqual(["Agency"]);
    expect(await dashboard(client)).toEqual([]);
  });

  it("UAT-D7 a scrape is caught with ownership read from the project's own RLS policies; public profiles stay quiet", async () => {
    const s = await pickProject("Notes app");
    policies = () => [
      { schemaname: "public", tablename: "notes", permissive: "PERMISSIVE", roles: ["authenticated"], cmd: "ALL", qual: "(auth.uid() = user_id)" },
      { schemaname: "public", tablename: "profiles", permissive: "PERMISSIVE", roles: ["public"], cmd: "SELECT", qual: "true" },
      { schemaname: "public", tablename: "profiles", permissive: "PERMISSIVE", roles: ["authenticated"], cmd: "UPDATE", qual: "(( SELECT auth.uid() AS uid) = id)" },
    ];
    logs = (now) => {
      const seen = new Date(now.getTime() - 200_000);
      return [
        scrape(seen),
        // Alice views Bob's public profile: normal on a public-read table.
        row(seen, {
          method: "GET", path: "/rest/v1/profiles", search: `?id=eq.${BOB}`, userAgent: CHROME_UA, asn: "7922",
          asOrganization: "Comcast", jwtSubject: ALICE, jwtRole: "authenticated", apiKeyRole: "anon", hits: "3",
        }),
      ];
    };
    expect(await poll(s, T0)).toMatchObject({ status: "ok", findings: 1, notified: 1 });
    expect((await dashboard(s)).map((i) => i.severity)).toEqual(["critical"]);
    expect((await projects(s))[0]!.crossTenant).toBe("assessed");
  });

  it("UAT-D8 a project whose RLS policies cannot be read shows detector 2 as 'unable to assess', and detector 4 still alerts", async () => {
    const s = await pickProject("Locked app");
    policies = () => { throw new SqlQueryError("forbidden", 403); };
    logs = (now) => [scrape(new Date(now.getTime() - 200_000)), serviceKeyFromBrowser(new Date(now.getTime() - 200_000))];
    expect(await poll(s, T0)).toMatchObject({ status: "ok", findings: 1, notified: 1 });
    expect(await projects(s)).toMatchObject([{ lastRunStatus: "ok", crossTenant: "unable_to_assess" }]);
    expect((await dashboard(s)).map((i) => i.severity)).toEqual(["critical"]);
  });

  it("UAT-D9 a project whose policies scope no table to an owner reads 'no owner-scoped tables', not clean", async () => {
    const s = await pickProject("Team app");
    policies = () => [{
      schemaname: "public", tablename: "notes", permissive: "PERMISSIVE", roles: ["authenticated"], cmd: "ALL",
      qual: "(team_id IN ( SELECT m.team_id FROM members m WHERE (m.user_id = auth.uid())))",
    }];
    logs = (now) => normalTraffic(new Date(now.getTime() - 200_000));
    expect(await poll(s, T0)).toMatchObject({ status: "ok", findings: 0 });
    expect(await projects(s)).toMatchObject([{ lastRunStatus: "ok", crossTenant: "no_owned_tables" }]);
  });
  it("UAT-D13 anon-key reads of a table the posture scan shows open raise a paging incident from the next poll", async () => {
    const s = await watchProject("Shop app");
    // Posture: customers has RLS off and anon may SELECT it; orders is locked down.
    const posture: PollDeps["posture"] = {
      querySql: async () => [
        { kind: "table", schema_name: "public", object_name: "customers", rls_enabled: false, policy_count: 0, grants: "anon:SELECT,authenticated:SELECT" },
        { kind: "table", schema_name: "public", object_name: "orders", rls_enabled: true, policy_count: 1, grants: "anon:SELECT,authenticated:SELECT" },
        { kind: "policy", schema_name: "public", object_name: "orders", policy_name: "own", permissive: "PERMISSIVE", roles: "{authenticated}", cmd: "SELECT", qual: "(auth.uid() = user_id)" },
      ],
      queryAdvisor: async () => [],
    };
    const sqls: string[] = [];
    const dump = (seen: Date) => row(seen, {
      method: "GET", path: "/rest/v1/customers", search: "?select=*", userAgent: "curl/8.7.1", contentRange: "0-999/*",
      asn: "14061", asOrganization: "DigitalOcean, LLC", jwtRole: "anon", apiKeyRole: "anon", hits: "4",
    });
    logs = (now) => [dump(new Date(now.getTime() - 130_000))];
    const capture = { queryLogs: async (q: LogsQuery) => { sqls.push(q.sql); return logs(T0, q); } };

    // First poll: the scan runs; the logs query was fixed (and audited) before it, so nothing yet.
    expect(await poll(s, T0, { posture, ...capture })).toMatchObject({ status: "ok", findings: 0 });
    expect(sqls[0]).not.toContain("/rest/v1/customers");

    // Next poll: the anon branch watches customers only, and the dump pages.
    logs = (now) => [dump(new Date(now.getTime() - 130_000))];
    const capture2 = { queryLogs: async (q: LogsQuery) => { sqls.push(q.sql); return logs(at(60), q); } };
    expect(await poll(s, at(60), { posture, ...capture2 })).toMatchObject({ status: "ok", findings: 1, notified: 1 });
    expect(sqls[1]).toContain("'/rest/v1/customers'");
    expect(sqls[1]).not.toContain("/rest/v1/orders");
    const open = await dashboard(s);
    expect(open).toHaveLength(1);
    // 4 requests of 1,000 rows from an RLS-off table: a bulk read, critical.
    expect(open[0]).toMatchObject({ severity: "critical", detectors: ["exposed_read"], hits: 4 });
    expect(open[0]!.summary?.summary).toContain("`customers`");
  });

  it("UAT-D12 REST traffic whose logs carry no user or key role reads both detectors as 'unable to assess', not clean", async () => {
    const s = await watchProject("New keys app");
    // sb_secret_ keys are not JWTs (#130): the rollup finds nothing, the coverage count finds REST traffic.
    logs = (_now, q) => (q.sql.includes("rest_with_auth") ? [{ rest_requests: 240, rest_with_auth: 0 }] : []);
    expect(await poll(s, T0)).toMatchObject({ status: "ok", findings: 0 });
    expect(await projects(s)).toMatchObject([{ lastRunStatus: "ok", crossTenant: "unable_to_assess" }]);
    const run = await withTenant(db.app, s.tenantId, (tx) => tx.query<{ unassessed_detectors: string[] }>(
      "SELECT unassessed_detectors FROM supahound.poll_runs"));
    expect(run).toEqual([{ unassessed_detectors: ["cross_tenant", "service_role_misuse"] }]);
  });

  // Issue #129: the rollup keeps its busiest 5000 templates, so a burst of normal traffic could push
  // a single probe out of the answer and still read as clean.
  // A fake Supabase that, like the real rollup, returns the window's busiest templates up to the query's LIMIT.
  const inWindow = (rows: Record<string, unknown>[]) => (_now: Date, q: LogsQuery) => rows
    .filter((r) => Date.parse(r.first_seen as string) >= q.start.getTime() && Date.parse(r.first_seen as string) < q.end.getTime())
    .sort((a, b) => Number(b.hits) - Number(a.hits))
    .slice(0, Number(/LIMIT (\d+)$/.exec(q.sql)?.[1] ?? 0)); // a query without LIMIT (the #130 coverage count) gets no rows
  const busyMinute = (seen: Date) => Array.from({ length: ROLLUP_LIMIT + 1 }, (_, i) => row(seen, {
    method: "GET", path: "/rest/v1/notes", search: `?user_id=eq.${BOB}&offset=${i}`, userAgent: CHROME_UA, asn: "7922",
    asOrganization: "Comcast", jwtSubject: BOB, jwtRole: "authenticated", apiKeyRole: "anon", hits: "50",
  }));

  it("UAT-D10 a lone probe in a window too busy to read whole still raises its incident", async () => {
    const s = await watchProject("Busy app");
    logs = inWindow([scrape(at(-400), "1"), ...busyMinute(at(-140))]);
    expect(await poll(s, T0)).toMatchObject({ status: "ok", findings: 1, notified: 1 });
    expect((await dashboard(s)).map((i) => i.severity)).toEqual(["critical"]);
  });

  it("UAT-D11 a minute with more traffic than one poll can read is 'unable to assess', never an all-clear", async () => {
    const s = await watchProject("Flooded app");
    logs = inWindow([scrape(at(-140), "1"), ...busyMinute(at(-400))]);
    expect(await poll(s, T0)).toEqual({ status: "unable_to_assess", errorCode: "rollup_saturated" });
    expect((await projects(s))[0]!.lastRunStatus).toBe("unable_to_assess");
  });
});
