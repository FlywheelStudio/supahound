import { createHash, randomUUID } from "node:crypto";
import { beforeAll, beforeEach, describe, expect, it } from "vitest";
import { POSTURE_SQL } from "../../src/config/posture.js";
import * as posture from "../../src/db/posture.js";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import type { ExplainResult } from "../../src/explainer/llm.js";
import { templateExplanation } from "../../src/explainer/template.js";
import { SqlQueryError } from "../../src/ownership/client.js";
import { ownershipFromPolicies } from "../../src/ownership/ownership.js";
import { AdvisorApiError, parseLints, type AdvisorLint } from "../../src/posture/advisor.js";
import { catalogFindings, parseCatalogRows } from "../../src/posture/catalog.js";
import { POSTURE_SIGNAL } from "../../src/posture/findings.js";
import {
  pollProject, POSTURE_REFRESH_SECONDS, POSTURE_RETRY_SECONDS, type PollDeps,
} from "../../src/poller/pollProject.js";
import { runDuePolls } from "../../src/poller/scheduler.js";
import { projectScope, tenantId, verifiedUserId, type ProjectId, type ProjectScope, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { ALICE, BOB } from "../helpers.js";
import { pgInfo, useDb } from "./harness.js";

// Posture scan (issue #11, decision 038) against Postgres under forced RLS: scheduling inside the
// poll (first poll, daily, retry, Scan now), storage per source, the severity raise, RLS for
// signed-in users, and POSTURE_SQL itself on a real catalog. Supabase is faked. Synthetic data only.

const REF = "abcdefghijklmnopqrst";
const T0 = new Date("2026-11-10T12:30:00Z");
const after = (seconds: number, from = T0) => new Date(from.getTime() + seconds * 1000);
const ALL = "anon:DELETE,anon:INSERT,anon:SELECT,anon:UPDATE,authenticated:DELETE,authenticated:INSERT,authenticated:SELECT,authenticated:UPDATE";

const tableRow = (name: string, rls: boolean, policies = 0) => ({
  kind: "table", schema_name: "public", object_name: name, rls_enabled: rls, rls_forced: false, policy_count: policies,
  security_invoker: false, grants: ALL, policy_name: null, permissive: null, roles: null, cmd: null, qual: null, with_check: null,
});
const viewRow = (name: string) => ({ ...tableRow(name, false), kind: "view" });
const lint = (name: string, object: string, level = "ERROR", type = "table") => ({
  name, title: "t", level, facing: "EXTERNAL", categories: ["SECURITY"], description: "d", detail: "d", remediation: "r",
  metadata: { schema: "public", name: object, type }, cache_key: `${name}_${object}`,
});

// Messages: owned by sender or receiver (multi-party, so detector 2 rates it below critical).
const MESSAGES_POLICY = {
  schemaname: "public", tablename: "messages", permissive: "PERMISSIVE", roles: ["authenticated"], cmd: "ALL",
  qual: "((auth.uid() = sender_id) OR (auth.uid() = receiver_id))",
};
// Alice lists Bob's received messages without pinning herself.
const logRows = (now: Date) => {
  const seen = new Date(now.getTime() - 200_000).toISOString();
  return [{
    method: "GET", path: "/rest/v1/messages", search: `?receiver_id=eq.${BOB}`, status: "200", contentRange: "0-9/*",
    userAgent: "python-httpx/0.28.1", asn: "14061", asOrganization: "DigitalOcean, LLC",
    jwtSubject: ALICE, jwtRole: "authenticated", apiKeyRole: "anon", hits: "5", first_seen: seen, last_seen: seen,
  }];
};

describe.skipIf(pgInfo === null)("posture scan in the poll", () => {
  const db = useDb();
  let sqlCalls: { sql: string; auditedFirst: boolean }[];
  let advisorCalls: number;
  let catalog: () => Record<string, unknown>[];
  let advisor: () => AdvisorLint[];

  async function watch(name: string): Promise<ProjectScope> {
    const t = tenantId(randomUUID());
    return withTenant(db.app, t, async (tx) => {
      await repo.createTenant(tx, name);
      const conn = await repo.createConnection(tx, db.vault, { label: name, token: `token-${randomUUID()}` });
      const p = await repo.createProject(tx, { connectionId: conn, supabaseRef: REF, name });
      await repo.setOwnership(tx, p, ownershipFromPolicies([MESSAGES_POLICY]));
      return projectScope(t, p);
    });
  }

  function deps(s: ProjectScope, now: Date, logs = false): PollDeps {
    return {
      app: db.app, vault: db.vault, now: () => now, intervalSeconds: 0,
      queryLogs: async () => (logs ? logRows(now) : []),
      queryPolicies: async () => { throw new Error("ownership was hand-set"); },
      explain: async (f): Promise<ExplainResult> =>
        ({ explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] }),
      posture: {
        querySql: async (q) => {
          const audited = await db.admin.query(
            `SELECT 1 FROM supahound.audit_log WHERE tenant_id = $1 AND project_id = $2 AND action = 'policies_query'
               AND detail->>'purpose' = 'posture_scan' AND created_at >= now() - interval '5 seconds'`,
            [s.tenantId, s.projectId],
          );
          sqlCalls.push({ sql: q.sql, auditedFirst: audited.rows.length > 0 });
          return catalog();
        },
        queryAdvisor: async () => {
          advisorCalls += 1;
          return advisor();
        },
      },
    };
  }
  const poll = (s: ProjectScope, now: Date, logs = false) => pollProject(s, deps(s, now, logs));
  const scan = (s: ProjectScope) => withTenant(db.app, s.tenantId, (tx) => posture.getPostureScan(tx, s.projectId));
  const found = (s: ProjectScope) => withTenant(db.app, s.tenantId, (tx) => posture.listPostureFindings(tx, s.projectId))
    .then((l) => l.map((f) => `${f.source}:${f.check}:${f.object}:${f.severity}`).sort());

  beforeEach(() => {
    sqlCalls = [];
    advisorCalls = 0;
    catalog = () => [tableRow("messages", false, 1), tableRow("profiles", true, 0), viewRow("leaderboard")];
    advisor = () => parseLints([lint("rls_disabled_in_public", "messages"), lint("function_search_path_mutable", "touch", "WARN", "function")]);
  });

  it("scans on the first poll, audits before calling Supabase, and stores both sources", async () => {
    const s = await watch("First");
    expect(await poll(s, T0)).toMatchObject({ status: "ok" });
    expect(sqlCalls).toEqual([{ sql: POSTURE_SQL, auditedFirst: true }]);
    expect(advisorCalls).toBe(1);
    const audit = await withTenant(db.app, s.tenantId, (tx) =>
      tx.query<{ detail: Record<string, unknown> }>("SELECT detail FROM supahound.audit_log WHERE action = 'policies_query'"));
    expect(audit.map((a) => a.detail)).toEqual([
      { purpose: "posture_scan", sql_sha256: createHash("sha256").update(POSTURE_SQL).digest("hex"), security_advisor: true },
    ]);
    // The Advisor's rls_disabled_in_public duplicates the catalog's rls_disabled on messages: dropped.
    expect(await found(s)).toEqual([
      "advisor:function_search_path_mutable:touch:medium",
      "catalog:rls_disabled:messages:critical",
      "catalog:rls_no_policies:profiles:low",
      "catalog:view_not_invoker:leaderboard:high",
    ]);
    expect(await scan(s)).toMatchObject({
      catalogStatus: "ok", advisorStatus: "ok", catalogScannedAt: T0, advisorScannedAt: T0, finishedAt: T0,
      tablesChecked: 2, viewsChecked: 1, policiesChecked: 0,
    });
  });

  it("runs again only after 24 hours, and replaces the findings", async () => {
    const s = await watch("Daily");
    await poll(s, T0);
    await poll(s, after(60));
    await poll(s, after(POSTURE_REFRESH_SECONDS - 60));
    expect(sqlCalls).toHaveLength(1);
    catalog = () => [tableRow("messages", true, 1)];
    await poll(s, after(POSTURE_REFRESH_SECONDS));
    expect(sqlCalls).toHaveLength(2);
    expect(await found(s)).toEqual(["advisor:function_search_path_mutable:touch:medium", "advisor:rls_disabled_in_public:messages:high"]);
  });

  it("keeps the last good catalog findings when the catalog read fails, and retries after an hour", async () => {
    const s = await watch("Flaky");
    await poll(s, T0);
    const before = await found(s);
    catalog = () => { throw new SqlQueryError("forbidden", 403); };
    await poll(s, after(POSTURE_REFRESH_SECONDS));
    expect(await found(s)).toEqual(before);
    expect(await scan(s)).toMatchObject({ catalogStatus: "unauthorized", catalogScannedAt: T0, advisorStatus: "ok" });
    await poll(s, after(POSTURE_REFRESH_SECONDS + POSTURE_RETRY_SECONDS - 60));
    expect(sqlCalls).toHaveLength(2);
    catalog = () => [tableRow("messages", true, 1)];
    await poll(s, after(POSTURE_REFRESH_SECONDS + POSTURE_RETRY_SECONDS));
    expect(sqlCalls).toHaveLength(3);
    expect(await scan(s)).toMatchObject({ catalogStatus: "ok" });
  });

  it("records an Advisor failure or its 'unavailable' lint as unable to assess, keeping its last findings", async () => {
    const s = await watch("Advisor down");
    await poll(s, T0);
    advisor = () => { throw new AdvisorApiError("forbidden", 403); };
    await poll(s, after(POSTURE_REFRESH_SECONDS));
    expect(await scan(s)).toMatchObject({ catalogStatus: "ok", advisorStatus: "unauthorized", advisorScannedAt: T0 });
    expect(await found(s)).toContain("advisor:function_search_path_mutable:touch:medium");
    advisor = () => parseLints([lint("advisor_check_unavailable", "x")]);
    await poll(s, after(2 * POSTURE_REFRESH_SECONDS));
    expect(await scan(s)).toMatchObject({ advisorStatus: "unavailable" });
    expect(await found(s)).toContain("advisor:function_search_path_mutable:touch:medium");
  });

  it("never fails the poll: a crash in the scan still lets the detectors run", async () => {
    const s = await watch("Crash");
    catalog = () => { throw new TypeError("fetch failed"); };
    advisor = () => { throw new TypeError("fetch failed"); };
    expect(await poll(s, T0, true)).toMatchObject({ status: "ok", findings: 1 });
    expect(await scan(s)).toMatchObject({ catalogStatus: "network_error", advisorStatus: "network_error" });
  });

  it("raises a detection on a table that posture shows exposed, and only there", async () => {
    const exposedP = await watch("Exposed");
    const controlP = await watch("Control");
    await poll(exposedP, T0, true);
    catalog = () => [tableRow("messages", true, 1)];
    advisor = () => [];
    await poll(controlP, T0, true);
    const detection = (s: ProjectScope) => withTenant(db.app, s.tenantId, async (tx) =>
      (await tx.query<{ severity: string; signals: string[]; evidence: Record<string, unknown> }>(
        "SELECT severity, signals, evidence FROM supahound.findings WHERE detector = 'cross_tenant'"))[0]!);
    const control = await detection(controlP);
    const raised = await detection(exposedP);
    const rank = { low: 1, medium: 2, high: 3, critical: 4 } as Record<string, number>;
    expect(rank[raised.severity]).toBe(rank[control.severity]! + 1);
    expect(raised.signals).toContain(POSTURE_SIGNAL);
    expect(raised.evidence.postureCheck).toBe("rls_disabled");
    expect(control.signals).not.toContain(POSTURE_SIGNAL);
    const incident = await withTenant(db.app, exposedP.tenantId, async (tx) => (await repo.openIncidents(tx, exposedP.projectId))[0]!);
    expect(incident.signals).toContain(POSTURE_SIGNAL);
  });

  it("raises from stored findings on later polls, when no scan runs", async () => {
    const s = await watch("Stored");
    await poll(s, T0);
    await poll(s, after(120), true);
    expect(sqlCalls).toHaveLength(1);
    const row = await withTenant(db.app, s.tenantId, async (tx) =>
      (await tx.query<{ signals: string[] }>("SELECT signals FROM supahound.findings WHERE detector = 'cross_tenant'"))[0]!);
    expect(row.signals).toContain(POSTURE_SIGNAL);
  });

  it("runs no scan without posture deps", async () => {
    const s = await watch("No deps");
    expect(await pollProject(s, { ...deps(s, T0), posture: null })).toMatchObject({ status: "ok" });
    expect([sqlCalls.length, advisorCalls, await scan(s)]).toEqual([0, 0, null]);
  });

  it("scans a project in its first poll right after the pick (the 2-minute promise)", async () => {
    const t = tenantId(randomUUID());
    await withTenant(db.app, t, async (tx) => {
      await repo.createTenant(tx, "Picker");
      const conn = await repo.createConnection(tx, db.vault, { label: "Picker", token: "token-picker" });
      await repo.watchProjects(tx, conn, [{ ref: "pickedprojectrefxxxx", name: "Picked" }]);
    });
    const now = new Date();
    const results = await runDuePolls({ ...deps(projectScope(t, randomUUID()), now), scheduler: db.scheduler, billing: "off", now: () => now });
    const mine = results.filter((r) => r.scope.tenantId === t);
    expect(mine).toHaveLength(1);
    expect(mine[0]!.outcome).toMatchObject({ status: "ok" });
    const s = mine[0]!.scope;
    expect(await scan(s)).toMatchObject({ catalogStatus: "ok", finishedAt: now });
    expect((await found(s)).length).toBeGreaterThan(0);
  });

  describe("Scan now", () => {
    it("queues a scan the next poll runs within the 24 hours, once", async () => {
      const s = await watch("On demand");
      const start = new Date(Date.now() - 3600_000);
      await poll(s, start);
      expect(await withTenant(db.app, s.tenantId, (tx) => posture.requestPostureScan(tx, s.projectId, randomUUID(), 60))).toBe("queued");
      expect(await withTenant(db.app, s.tenantId, (tx) => posture.requestPostureScan(tx, s.projectId, randomUUID(), 60))).toBe("already_queued");
      const now = new Date(Date.now() + 1000);
      await poll(s, now);
      expect(sqlCalls).toHaveLength(2);
      await poll(s, after(60, now));
      expect(sqlCalls).toHaveLength(2);
      // Right after a scan, another request is refused for the cooldown.
      expect(await withTenant(db.app, s.tenantId, (tx) => posture.requestPostureScan(tx, s.projectId, randomUUID(), 60))).toBe("too_soon");
    });

    it("works before the first scan ever ran", async () => {
      const s = await watch("Fresh");
      expect(await withTenant(db.app, s.tenantId, (tx) => posture.requestPostureScan(tx, s.projectId, randomUUID(), 60))).toBe("queued");
      await poll(s, new Date(Date.now() + 1000));
      expect(sqlCalls).toHaveLength(1);
    });
  });
});

describe.skipIf(pgInfo === null)("posture storage and RLS for signed-in users", () => {
  const db = useDb();
  const user = () => verifiedUserId(randomUUID());
  const u = { owner: user(), editor: user(), viewer: user(), stranger: user(), other: user() };
  let A: TenantId;
  let B: TenantId;
  let p1: ProjectId;
  let p2: ProjectId;
  let pB: ProjectId;
  const as = <T>(who: UserId, t: TenantId, fn: Parameters<typeof withTenantForUser<T>>[3]) => withTenantForUser(db.app, who, t, fn);

  async function addProject(t: TenantId, name: string, ref: string): Promise<ProjectId> {
    return withTenant(db.app, t, async (tx) => {
      const conn = await repo.createConnection(tx, db.vault, { label: name, token: `token-${randomUUID()}` });
      const p = await repo.createProject(tx, { connectionId: conn, supabaseRef: ref, name });
      const scanId = (await posture.claimPostureScan(tx, p, T0, { refreshSeconds: 1, retrySeconds: 1 }))!;
      await posture.savePostureScan(tx, p, scanId, {
        catalog: { status: "ok", findings: catalogFindings(parseCatalogRows([tableRow("notes", false)])) },
        advisor: { status: "ok", findings: [] },
      }, T0);
      return p;
    });
  }

  beforeAll(async () => {
    A = await createWorkspace(db.app, u.owner, "Agency");
    B = await createWorkspace(db.app, u.other, "Other");
    p1 = await addProject(A, "Shop", "aaaaaaaaaaaaaaaaaaaa");
    p2 = await addProject(A, "Blog", "bbbbbbbbbbbbbbbbbbbb");
    pB = await addProject(B, "Other app", "cccccccccccccccccccc");
    await withTenant(db.app, A, async (tx) => {
      for (const who of [u.editor, u.viewer, u.stranger]) {
        await tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [A, who]);
      }
      await tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'editor'), ($1, $2, $4, 'viewer')", [A, p1, u.editor, u.viewer]);
    });
  });

  const seen = (who: UserId, t: TenantId) => as(who, t, async (tx) => ({
    scans: (await tx.query<{ p: string }>("SELECT project_id::text AS p FROM supahound.posture_scans ORDER BY 1")).map((r) => r.p),
    findings: (await tx.query<{ p: string }>("SELECT DISTINCT project_id::text AS p FROM supahound.posture_findings ORDER BY 1")).map((r) => r.p),
    summaries: [...(await posture.postureSummaries(tx)).keys()].sort(),
  }));

  it("shows a project's posture only to people with a role on it", async () => {
    const both = [p1, p2].sort();
    expect(await seen(u.owner, A)).toEqual({ scans: both, findings: both, summaries: both });
    expect(await seen(u.viewer, A)).toEqual({ scans: [p1], findings: [p1], summaries: [p1] });
    expect(await seen(u.stranger, A)).toEqual({ scans: [], findings: [], summaries: [] });
  });

  it("never shows another tenant's posture, even by ID", async () => {
    expect(await seen(u.other, B)).toEqual({ scans: [pB], findings: [pB], summaries: [pB] });
    const leak = await withTenant(db.app, A, (tx) => tx.query("SELECT 1 FROM supahound.posture_findings WHERE project_id = $1", [pB]));
    expect(leak).toEqual([]);
    expect(await withTenant(db.app, A, (tx) => posture.listPostureFindings(tx, pB))).toEqual([]);
  });

  it("does not raise for a table the catalog rates low, even when the Advisor rates it high", async () => {
    const exposed = await withTenant(db.app, A, async (tx) => {
      const conn = await repo.createConnection(tx, db.vault, { label: "y", token: "t" });
      const p = await repo.createProject(tx, { connectionId: conn, supabaseRef: "eeeeeeeeeeeeeeeeeeee", name: "No grants" });
      const scanId = (await posture.claimPostureScan(tx, p, T0, { refreshSeconds: 1, retrySeconds: 1 }))!;
      await posture.savePostureScan(tx, p, scanId, {
        catalog: { status: "ok", findings: catalogFindings(parseCatalogRows([{ ...tableRow("quiet", false), grants: "" }, tableRow("loud", false)])) },
        advisor: { status: "ok", findings: parseLints([lint("rls_disabled_in_public", "quiet"), lint("rls_disabled_in_public", "loud")]).map((l) => ({
          source: "advisor" as const, check: l.name, severity: "high" as const, schema: l.schema, object: l.object, objectType: l.type, evidence: { level: l.level },
        })) },
      }, T0);
      return posture.postureExposedTables(tx, p);
    });
    expect([...exposed.keys()]).toEqual(["loud"]);
  });

  it("counts findings per project for the overview", async () => {
    const m = await as(u.owner, A, (tx) => posture.postureSummaries(tx));
    expect(m.get(p1)).toMatchObject({ counts: { critical: 1, high: 0, medium: 0, low: 0 }, scan: { catalogStatus: "ok" } });
  });

  it("lets owners and editors ask for a scan; RLS refuses a viewer and a stranger", async () => {
    expect(await as(u.editor, A, (tx) => posture.requestPostureScan(tx, p1, u.editor, 0))).toBe("queued");
    await expect(as(u.viewer, A, (tx) => posture.requestPostureScan(tx, p1, u.viewer, 0))).rejects.toThrow(/row-level security/);
    await expect(as(u.stranger, A, (tx) => posture.requestPostureScan(tx, p1, u.stranger, 0))).rejects.toThrow(/row-level security/);
    // A plain UPDATE (not the upsert, whose INSERT check already refuses) changes nothing for a viewer.
    expect(await as(u.viewer, A, (tx) => tx.query("UPDATE supahound.posture_scans SET requested_at = now() RETURNING id"))).toEqual([]);
    // Before the first scan, the request inserts the row: a viewer is refused there too.
    const p3 = await withTenant(db.app, A, async (tx) => {
      const conn = await repo.createConnection(tx, db.vault, { label: "x", token: "t" });
      const p = await repo.createProject(tx, { connectionId: conn, supabaseRef: "dddddddddddddddddddd", name: "New" });
      await tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'viewer')", [A, p, u.viewer]);
      return p;
    });
    await expect(as(u.viewer, A, (tx) => posture.requestPostureScan(tx, p3, u.viewer, 0))).rejects.toThrow(/row-level security/);
    expect(await as(u.owner, A, (tx) => posture.requestPostureScan(tx, p3, u.owner, 0))).toBe("queued");
  });

  it("lets no signed-in user write or delete findings, the owner included", async () => {
    await expect(as(u.owner, A, (tx) => tx.query(
      `INSERT INTO supahound.posture_findings (tenant_id, project_id, scan_id, source, check_id, severity)
       SELECT tenant_id, project_id, id, 'catalog', 'rls_disabled', 'low' FROM supahound.posture_scans WHERE project_id = $1`, [p1],
    ))).rejects.toThrow(/row-level security/);
    const deleted = await as(u.owner, A, (tx) => tx.query("DELETE FROM supahound.posture_findings RETURNING id"));
    expect(deleted).toEqual([]);
    const updated = await as(u.owner, A, (tx) => tx.query("UPDATE supahound.posture_findings SET severity = 'low' RETURNING id"));
    expect(updated).toEqual([]);
  });

  it("refuses free text in check names and names with control characters", async () => {
    await expect(withTenant(db.app, A, (tx) => tx.query(
      `INSERT INTO supahound.posture_findings (tenant_id, project_id, scan_id, source, check_id, severity)
       SELECT tenant_id, project_id, id, 'advisor', 'Drop table x', 'low' FROM supahound.posture_scans WHERE project_id = $1`, [p1],
    ))).rejects.toThrow(/check constraint/);
    await expect(withTenant(db.app, A, (tx) => tx.query(
      `INSERT INTO supahound.posture_findings (tenant_id, project_id, scan_id, source, check_id, severity, object_name)
       SELECT tenant_id, project_id, id, 'catalog', 'rls_disabled', 'low', E'a\\nb' FROM supahound.posture_scans WHERE project_id = $1`, [p1],
    ))).rejects.toThrow(/check constraint/);
  });

  it("cannot attach a finding to another tenant's project or scan", async () => {
    const scanB = await withTenant(db.app, B, async (tx) => (await posture.getPostureScan(tx, pB))!.id);
    const scanA = await withTenant(db.app, A, async (tx) => (await posture.getPostureScan(tx, p1))!.id);
    const tryInsert = (project: string, scanId: string) => withTenant(db.app, A, (tx) => tx.query(
      `INSERT INTO supahound.posture_findings (tenant_id, project_id, scan_id, source, check_id, severity) VALUES ($1, $2, $3, 'catalog', 'rls_disabled', 'low')`,
      [A, project, scanId]));
    await expect(tryInsert(pB, scanA)).rejects.toThrow(/foreign key/);
    await expect(tryInsert(p1, scanB)).rejects.toThrow(/foreign key/);
  });

  it("removes a project's posture with the project, when its owner removes it", async () => {
    expect(await as(u.owner, A, (tx) => repo.removeProject(tx, p2))).toBe(true);
    const left = await db.admin.query("SELECT (SELECT count(*) FROM supahound.posture_scans WHERE project_id = $1)::int AS s, (SELECT count(*) FROM supahound.posture_findings WHERE project_id = $1)::int AS f", [p2]);
    expect(left.rows[0]).toEqual({ s: 0, f: 0 });
  });
});

describe.skipIf(pgInfo === null)("POSTURE_SQL on a real Postgres catalog", () => {
  const db = useDb();

  beforeAll(async () => {
    await db.admin.query(`DO $$ BEGIN
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'anon') THEN CREATE ROLE anon NOLOGIN; END IF;
      IF NOT EXISTS (SELECT 1 FROM pg_roles WHERE rolname = 'authenticated') THEN CREATE ROLE authenticated NOLOGIN; END IF;
    END $$`);
    await db.admin.query(`
      CREATE TABLE public.open_notes (id int, user_id uuid);
      CREATE TABLE public.private_notes (id int, user_id uuid);
      ALTER TABLE public.private_notes ENABLE ROW LEVEL SECURITY;
      ALTER TABLE public.private_notes FORCE ROW LEVEL SECURITY;
      CREATE POLICY own ON public.private_notes FOR ALL TO authenticated USING (auth_uid() = user_id);
      CREATE TABLE public.locked (id int);
      ALTER TABLE public.locked ENABLE ROW LEVEL SECURITY;
      CREATE TABLE public.guestbook (id int, body text);
      ALTER TABLE public.guestbook ENABLE ROW LEVEL SECURITY;
      CREATE POLICY "anyone signs" ON public.guestbook FOR INSERT TO anon WITH CHECK (true);
      CREATE POLICY "anyone reads" ON public.guestbook FOR SELECT USING (true);
      CREATE TABLE public.internal (id int);
      CREATE VIEW public.definer_view AS SELECT id FROM public.private_notes;
      CREATE VIEW public.invoker_view WITH (security_invoker = on) AS SELECT id FROM public.private_notes;
      GRANT SELECT, INSERT, UPDATE, DELETE ON public.open_notes, public.private_notes, public.locked, public.guestbook TO anon, authenticated;
      GRANT SELECT ON public.definer_view, public.invoker_view TO anon, authenticated;
    `.replace("auth_uid()", "current_setting('x.uid', true)::uuid"));
  });

  it("returns rows the parser reads, and the checks find exactly the planted problems", async () => {
    const rows = (await db.admin.query(POSTURE_SQL)).rows as Record<string, unknown>[];
    const parsed = parseCatalogRows(rows);
    expect(parsed.skipped).toBe(0);
    expect(parsed.relations.find((r) => r.name === "private_notes")).toMatchObject({ rlsEnabled: true, rlsForced: true, policyCount: 1 });
    expect(parsed.relations.find((r) => r.name === "invoker_view")).toMatchObject({ kind: "view", securityInvoker: true });
    const got = catalogFindings(parsed).map((f) => `${f.check}:${f.object}:${f.severity}`).sort();
    expect(got).toEqual([
      "permissive_policy:guestbook:critical",
      "permissive_policy:guestbook:medium",
      "rls_disabled:internal:low",
      "rls_disabled:open_notes:critical",
      "rls_no_policies:locked:low",
      "view_not_invoker:definer_view:high",
    ]);
  });
});
