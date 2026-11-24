import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as settings from "../../src/db/detectionSettings.js";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import { templateExplanation } from "../../src/explainer/template.js";
import { pollProject, type PollDeps } from "../../src/poller/pollProject.js";
import { projectScope, verifiedUserId, type ProjectId, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

// Expected networks and network memory by name (issue #185, decision 050). RLS and the role rules
// per write, the audit trail, and their effect on a full poll.

const user = () => verifiedUserId(randomUUID());

describe("expectedNetworkName", () => {
  it("keeps only names already in the normalized form", () => {
    expect(settings.expectedNetworkName("comcast cable communications llc")).toBe("comcast cable communications llc");
    expect(settings.expectedNetworkName("a100 row gmbh")).toBe("a100 row gmbh");
    for (const bad of ["Comcast", "two  spaces", " lead", "trail ", "x'); DROP", "", "a".repeat(81), "café", null, 7]) {
      expect(settings.expectedNetworkName(bad), String(bad)).toBeNull();
    }
    expect(settings.expectedNetworkName("a".repeat(80))).toBe("a".repeat(80));
  });
});

describe.skipIf(pgInfo === null)("expected networks in Postgres", () => {
  const db = useDb();
  const u = { owner: user(), projAdmin: user(), editor: user(), viewer: user(), stranger: user(), other: user() };
  let A: TenantId;
  let B: TenantId;
  let p1: ProjectId;
  let p2: ProjectId;
  let pB: ProjectId;

  const as = <T>(who: UserId, t: TenantId, fn: Parameters<typeof withTenantForUser<T>>[3]) => withTenantForUser(db.app, who, t, fn);
  const sys = <T>(t: TenantId, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, t, fn);

  async function addProject(t: TenantId, name: string, ref: string): Promise<ProjectId> {
    return sys(t, async (tx) => {
      const conn = await repo.createConnection(tx, db.vault, { label: name, token: `token-${randomUUID()}` });
      return repo.createProject(tx, { connectionId: conn, supabaseRef: ref, name });
    });
  }

  const marks = (t: TenantId) => db.admin.query<{ project_id: string; network: string; marked_by: string | null }>(
    "SELECT project_id, network, marked_by FROM supahound.expected_networks WHERE tenant_id = $1 ORDER BY network",
    [t],
  ).then((r) => r.rows);
  const audits = (t: TenantId) => db.admin.query<{ detail: Record<string, unknown> }>(
    "SELECT detail FROM supahound.audit_log WHERE tenant_id = $1 AND action = 'detection_setting' ORDER BY created_at, id",
    [t],
  ).then((r) => r.rows.map((x) => x.detail));

  beforeAll(async () => {
    A = await createWorkspace(db.app, u.owner, "Agency", "owner@agency.test");
    B = await createWorkspace(db.app, u.other, "Other", "owner@other.test");
    p1 = await addProject(A, "Shop", "aaaaaaaaaaaaaaaaaaaa");
    p2 = await addProject(A, "Blog", "bbbbbbbbbbbbbbbbbbbb");
    pB = await addProject(B, "Other app", "cccccccccccccccccccc");
    await sys(A, async (tx) => {
      for (const who of [u.projAdmin, u.editor, u.viewer, u.stranger]) {
        await tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [A, who]);
      }
      for (const [who, role] of [[u.projAdmin, "admin"], [u.editor, "editor"], [u.viewer, "viewer"]] as const) {
        await tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)", [A, p1, who, role]);
      }
    });
  });

  it("lets the project's owners and admins mark and unmark, and audits each change", async () => {
    expect(await as(u.owner, A, (tx) => settings.markExpectedNetwork(tx, p1, "railway", u.owner))).toBe("marked");
    expect(await as(u.projAdmin, A, (tx) => settings.markExpectedNetwork(tx, p1, "example isp", u.projAdmin))).toBe("marked");
    expect(await as(u.owner, A, (tx) => settings.markExpectedNetwork(tx, p1, "railway", u.owner))).toBe("already");
    expect((await marks(A)).map((m) => [m.network, m.marked_by])).toEqual([["example isp", u.projAdmin], ["railway", u.owner]]);
    expect(await as(u.viewer, A, (tx) => settings.listExpectedNetworks(tx, p1))).toMatchObject([{ network: "example isp" }, { network: "railway" }]);

    expect(await as(u.projAdmin, A, (tx) => settings.unmarkExpectedNetwork(tx, p1, "example isp", u.projAdmin))).toBe(true);
    expect(await as(u.projAdmin, A, (tx) => settings.unmarkExpectedNetwork(tx, p1, "example isp", u.projAdmin))).toBe(false);
    expect((await marks(A)).map((m) => m.network)).toEqual(["railway"]);
    expect(await audits(A)).toEqual([
      { setting: "expected_network", change: "mark", network: "railway", by: u.owner },
      { setting: "expected_network", change: "mark", network: "example isp", by: u.projAdmin },
      { setting: "expected_network", change: "unmark", network: "example isp", by: u.projAdmin },
    ]);
  });

  it("refuses editors and viewers in RLS, for marks and unmarks", async () => {
    for (const who of [u.editor, u.viewer]) {
      await expect(as(who, A, (tx) => settings.markExpectedNetwork(tx, p1, "home isp", who)), who).rejects.toThrow(/row-level security/);
      expect(await as(who, A, (tx) => settings.unmarkExpectedNetwork(tx, p1, "railway", who)), who).toBe(false);
    }
    expect((await marks(A)).map((m) => m.network)).toEqual(["railway"]);
  });

  it("refuses a project admin on another project, and hides marks from strangers", async () => {
    await expect(as(u.projAdmin, A, (tx) => settings.markExpectedNetwork(tx, p2, "railway", u.projAdmin))).rejects.toThrow(/row-level security/);
    expect(await as(u.stranger, A, (tx) => settings.listExpectedNetworks(tx, p1))).toEqual([]);
    expect(await as(u.stranger, A, (tx) => settings.unmarkExpectedNetwork(tx, p1, "railway", u.stranger))).toBe(false);
  });

  it("stores only normalized names, in the app and in the database", async () => {
    expect(await as(u.owner, A, (tx) => settings.markExpectedNetwork(tx, p1, "Railway, Inc.", u.owner))).toBe("invalid");
    await expect(sys(A, (tx) => tx.query(
      "INSERT INTO supahound.expected_networks (tenant_id, project_id, network) VALUES ($1, $2, 'Bad Name')", [A, p1],
    ))).rejects.toThrow(/check constraint/);
  });

  it("never marks another tenant's project, and never shows another tenant's marks", async () => {
    await expect(sys(A, (tx) => tx.query(
      "INSERT INTO supahound.expected_networks (tenant_id, project_id, network) VALUES ($1, $2, 'railway')", [A, pB],
    ))).rejects.toThrow(/foreign key/);
    await expect(sys(A, (tx) => tx.query(
      "INSERT INTO supahound.expected_networks (tenant_id, project_id, network) VALUES ($1, $2, 'railway')", [B, pB],
    ))).rejects.toThrow(/row-level security/);
    expect(await as(u.other, B, (tx) => settings.markExpectedNetwork(tx, pB, "railway", u.other))).toBe("marked");
    expect(await as(u.owner, A, (tx) => settings.listExpectedNetworks(tx, pB))).toEqual([]);
  });

  it("lets only the poller write the network memory", async () => {
    await expect(as(u.owner, A, (tx) => repo.saveNetworkNames(tx, p1, ["railway"]))).rejects.toThrow(/row-level security/);
    await sys(A, (tx) => repo.saveNetworkNames(tx, p1, ["railway", "railway"]));
    expect(await sys(A, (tx) => repo.loadNetworkNames(tx, p1))).toEqual(["railway"]);
    expect(await sys(B, (tx) => repo.loadNetworkNames(tx, p1))).toEqual([]);
    expect(await as(u.stranger, A, (tx) => repo.loadNetworkNames(tx, p1))).toEqual([]);
  });

  describe("in a full poll", () => {
    const NOW = new Date("2026-11-24T12:30:00Z");
    const row = (org: string) => ({
      method: "POST", path: "/rest/v1/rpc/read", search: "", status: "200", contentRange: "",
      userAgent: "node", clientInfo: "supabase-js-node/2.80.0", asn: "", asOrganization: org,
      jwtSubject: "", jwtRole: "", apiKeyRole: "", apiKeyKind: "secret", authorizationKind: "secret", hits: "3",
      first_seen: "2026-11-24T12:27:00Z", last_seen: "2026-11-24T12:28:00Z",
    });
    let rows: Record<string, string>[] = [];
    let tick = 0;
    const deps = (): PollDeps => ({
      app: db.app,
      vault: db.vault,
      now: () => new Date(NOW.getTime() + (tick++) * 120_000),
      queryLogs: async () => rows,
      queryPolicies: async () => [],
      explain: async (f) => ({ explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] }),
      alerts: null,
    });
    const signals = (p: ProjectId) => db.admin.query<{ signals: string[] }>(
      "SELECT signals FROM supahound.findings WHERE project_id = $1 ORDER BY created_at, id", [p],
    ).then((r) => r.rows.map((x) => x.signals.join("+")));

    it("silences a marked home network, and learns hosting names silently on the first poll", async () => {
      const t = await createWorkspace(db.app, user(), "Poll Co", "owner@poll.test");
      const p = await addProject(t, "App", "dddddddddddddddddddd");
      const scope = projectScope(t, p);

      // First poll: a known platform and a home network. The platform is learned, not flagged.
      rows = [row("Railway"), row("Example Telecom AG")];
      expect(await pollProject(scope, deps())).toMatchObject({ status: "ok" });
      expect(await signals(p)).toEqual(["non_hosting_network"]);
      expect(await sys(t, (tx) => repo.loadNetworkNames(tx, p))).toEqual(["railway"]);

      // Later poll: a new provider is flagged once; the learned one is not.
      rows = [row("Railway"), row("Render")];
      await pollProject(scope, deps());
      expect(await signals(p)).toEqual(["non_hosting_network", "new_network"]);

      // The owner marks the home network as expected: no more network signal for it.
      await sys(t, (tx) => settings.markExpectedNetwork(tx, p, "example telecom ag", null));
      rows = [row("Example Telecom AG")];
      await pollProject(scope, deps());
      expect(await signals(p)).toEqual(["non_hosting_network", "new_network"]);
    });

    it("still flags a browser on a marked network", async () => {
      const t = await createWorkspace(db.app, user(), "Poll Two", "owner@poll2.test");
      const p = await addProject(t, "App", "eeeeeeeeeeeeeeeeeeee");
      await sys(t, (tx) => settings.markExpectedNetwork(tx, p, "example telecom ag", null));
      rows = [{
        ...row("Example Telecom AG"), clientInfo: "",
        userAgent: "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36",
      }];
      await pollProject(projectScope(t, p), deps());
      expect(await signals(p)).toEqual(["browser_caller"]);
    });
  });
});
