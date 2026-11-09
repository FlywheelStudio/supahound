import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import type { IncidentFeatures } from "../../src/explainer/features.js";
import type { ExplainResult } from "../../src/explainer/llm.js";
import { templateExplanation } from "../../src/explainer/template.js";
import { LogsApiError } from "../../src/logs/client.js";
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
  let logs: (now: Date) => Record<string, unknown>[];

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

  function poll(scope: ProjectScope, now: Date) {
    const deps: PollDeps = {
      app: db.app, vault: db.vault, now: () => now, intervalSeconds: 0,
      queryLogs: async () => logs(now),
      explain: async (f: IncidentFeatures): Promise<ExplainResult> =>
        ({ explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] }),
    };
    return pollProject(scope, deps);
  }

  const dashboard = (s: ProjectScope) => withTenant(db.app, s.tenantId, (tx) => repo.listOpenIncidents(tx));
  const projects = (s: ProjectScope) => withTenant(db.app, s.tenantId, (tx) => repo.listProjects(tx));

  beforeEach(() => {
    logs = () => [];
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
});
