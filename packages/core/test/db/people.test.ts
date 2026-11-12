import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as billing from "../../src/db/billing.js";
import * as people from "../../src/db/people.js";
import * as posture from "../../src/db/posture.js";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, NotAMemberError, withTenantForUser } from "../../src/db/user.js";
import { projectId, tenantId, verifiedUserId, type ProjectId, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

// People and roles per project (issue #24, decision 036): RLS by project inside the tenant, the
// write rules per role, and invites (expiry, single use, email binding, tenant binding).

const PROJECT_TABLES = [
  "projects", "service_role_networks", "poll_runs", "incidents", "findings", "project_usage", "audit_log",
  "posture_scans", "posture_findings", "project_subscriptions",
] as const;
const NOW = new Date("2026-11-12T12:00:00Z");
const user = () => verifiedUserId(randomUUID());

describe.skipIf(pgInfo === null)("people and roles per project", () => {
  const db = useDb();
  const u = { owner: user(), admin: user(), editor: user(), viewer: user(), stranger: user(), other: user() };
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
      const p = await repo.createProject(tx, { connectionId: conn, supabaseRef: ref, name });
      const run = await repo.startPollRun(tx, p, { start: new Date(NOW.getTime() - 60_000), end: NOW });
      const incident = await repo.upsertIncident(tx, p, {
        id: null, status: "open", actor: `user:${name}`, severity: "high", detectors: ["cross_tenant"], signals: ["other_owner"],
        findingCount: 1, hits: 3, openedAt: NOW, lastSeenAt: NOW,
      });
      await repo.insertFindings(tx, p, run, [{
        detector: "cross_tenant", severity: "high", actor: `user:${name}`, signals: ["other_owner"],
        firstSeen: NOW.toISOString(), lastSeen: NOW.toISOString(), hits: 3, evidence: { table: "notes" }, incidentId: incident,
      }]);
      await repo.saveNetworks(tx, p, [16509]);
      await repo.appendAudit(tx, { projectId: p, action: "logs_query", detail: { rows: 1 } });
      await billing.saveDailyUsage(tx, p, "2026-11-11", 10);
      await billing.saveProjectSubscription(tx, {
        subscriptionId: `sub_${ref}`, supabaseRef: ref, tier: "starter", status: "active", trialEnd: null,
        currentPeriodEnd: NOW, cancelAtPeriodEnd: false,
      }, p);
      const scanId = (await posture.claimPostureScan(tx, p, NOW, { refreshSeconds: 1, retrySeconds: 1 }))!;
      await posture.savePostureScan(tx, p, scanId, {
        catalog: { status: "ok", findings: [{ source: "catalog", check: "rls_disabled", severity: "high", schema: "public", object: "notes", objectType: "table", evidence: {} }] },
        advisor: null,
      }, NOW);
      return p;
    });
  }

  async function addMember(t: TenantId, who: UserId, role: "admin" | "member", email: string | null = null) {
    await sys(t, (tx) => tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role, email) VALUES ($1, $2, $3, $4)", [t, who, role, email]));
  }
  async function grant(t: TenantId, p: ProjectId, who: UserId, role: people.ProjectRole) {
    await sys(t, (tx) => tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)", [t, p, who, role]));
  }

  beforeAll(async () => {
    A = await createWorkspace(db.app, u.owner, "Agency", "owner@agency.test");
    B = await createWorkspace(db.app, u.other, "Other", "owner@other.test");
    p1 = await addProject(A, "Shop", "aaaaaaaaaaaaaaaaaaaa");
    p2 = await addProject(A, "Blog", "bbbbbbbbbbbbbbbbbbbb");
    pB = await addProject(B, "Other app", "cccccccccccccccccccc");
    await addMember(A, u.admin, "admin", "admin@agency.test");
    await addMember(A, u.editor, "member", "editor@agency.test");
    await addMember(A, u.viewer, "member", "viewer@agency.test");
    await addMember(A, u.stranger, "member", "stranger@agency.test");
    await grant(A, p1, u.editor, "editor");
    await grant(A, p1, u.viewer, "viewer");
    // A workspace-wide audit row (no project).
    await sys(A, (tx) => repo.appendAudit(tx, { projectId: null, action: "model_call", detail: { n: 1 } }));
  });

  describe("project visibility (RLS)", () => {
    const projectsSeen = async (who: UserId, table: string) =>
      as(who, A, async (tx) => {
        const col = table === "projects" ? "id" : "project_id";
        const rows = await tx.query<{ p: string | null }>(`SELECT DISTINCT ${col}::text AS p FROM supahound.${table}`);
        return rows.map((r) => r.p).filter((p) => p !== null).sort();
      });

    it("shows workspace owners and admins every project's rows, in every project table", async () => {
      for (const who of [u.owner, u.admin]) {
        for (const table of PROJECT_TABLES) expect(await projectsSeen(who, table), table).toEqual([p1, p2].sort());
      }
    });

    it("shows editors and viewers only the projects they have a role on", async () => {
      for (const who of [u.editor, u.viewer]) {
        for (const table of PROJECT_TABLES) expect(await projectsSeen(who, table), table).toEqual([p1]);
      }
    });

    it("shows a workspace member with no project role nothing", async () => {
      for (const table of PROJECT_TABLES) expect(await projectsSeen(u.stranger, table), table).toEqual([]);
      expect(await as(u.stranger, A, (tx) => repo.listProjects(tx))).toEqual([]);
      expect(await as(u.stranger, A, (tx) => repo.listOpenIncidents(tx, 50))).toEqual([]);
    });

    it("keeps the whole tenant for transactions without a user (poller, billing, webhooks)", async () => {
      const seen = await sys(A, (tx) => tx.query<{ id: string }>("SELECT id FROM supahound.projects"));
      expect(seen.map((r) => r.id).sort()).toEqual([p1, p2].sort());
      expect((await sys(A, (tx) => billing.projectTiers(tx))).length).toBe(2);
    });

    it("shows workspace-wide audit rows to owners and admins only", async () => {
      const count = (who: UserId) =>
        as(who, A, async (tx) => (await tx.query<{ n: number }>("SELECT count(*)::int AS n FROM supahound.audit_log WHERE project_id IS NULL"))[0]!.n);
      expect([await count(u.owner), await count(u.admin), await count(u.editor), await count(u.viewer)]).toEqual([1, 1, 0, 0]);
    });

    it("never shows another tenant's project, whatever the role", async () => {
      for (const who of [u.owner, u.admin, u.editor]) {
        const rows = await as(who, A, (tx) => tx.query("SELECT id FROM supahound.projects WHERE id = $1", [pB]));
        expect(rows).toEqual([]);
        expect(await as(who, A, (tx) => people.projectRole(tx, pB))).toBeNull();
      }
    });

    it("returns each user's effective role, and the role in listProjects", async () => {
      const roles = async (who: UserId) => as(who, A, async (tx) => [await people.projectRole(tx, p1), await people.projectRole(tx, p2)]);
      expect(await roles(u.owner)).toEqual(["owner", "owner"]);
      expect(await roles(u.admin)).toEqual(["admin", "admin"]);
      expect(await roles(u.editor)).toEqual(["editor", null]);
      expect(await roles(u.viewer)).toEqual(["viewer", null]);
      expect(await roles(u.stranger)).toEqual([null, null]);
      expect((await as(u.editor, A, (tx) => repo.listProjects(tx))).map((p) => [p.name, p.role])).toEqual([["Shop", "editor"]]);
      expect((await sys(A, (tx) => repo.listProjects(tx))).map((p) => p.role)).toEqual([null, null]);
      await expect(as(u.editor, B, async () => undefined)).rejects.toThrow(NotAMemberError);
    });

    it("lets a workspace admin hold the Owner role on one project", async () => {
      const p3 = await addProject(A, "Admin owned", "dddddddddddddddddddd");
      await grant(A, p3, u.admin, "owner");
      expect(await as(u.admin, A, (tx) => people.projectRole(tx, p3))).toBe("owner");
      expect(await as(u.admin, A, (tx) => people.projectRole(tx, p1))).toBe("admin");
      await sys(A, (tx) => repo.removeProject(tx, p3));
    });
  });

  describe("writes per role (RLS)", () => {
    const setAlerts = (who: UserId, p: ProjectId) => as(who, A, (tx) => repo.setEmailAlerts(tx, p, "high"));

    it("lets owners, admins and editors change settings, and not viewers", async () => {
      expect(await setAlerts(u.viewer, p1)).toBe(false);
      expect(await setAlerts(u.stranger, p1)).toBe(false);
      expect(await setAlerts(u.editor, p2)).toBe(false);
      for (const who of [u.editor, u.admin, u.owner]) expect(await setAlerts(who, p1)).toBe(true);
    });

    it("lets the project's Owner and workspace owners and admins remove a project, and nobody else", async () => {
      const p3 = await addProject(A, "Disposable", "eeeeeeeeeeeeeeeeeeee");
      await grant(A, p3, u.editor, "editor");
      await grant(A, p3, u.viewer, "admin");
      expect(await as(u.editor, A, (tx) => repo.removeProject(tx, p3))).toBe(false);
      expect(await as(u.viewer, A, (tx) => repo.removeProject(tx, p3))).toBe(false);
      await sys(A, (tx) => tx.query("UPDATE supahound.project_members SET role = 'owner' WHERE project_id = $1 AND user_id = $2", [p3, u.editor]));
      expect(await as(u.editor, A, (tx) => repo.removeProject(tx, p3))).toBe(true);
      const p4 = await addProject(A, "Disposable 2", "ffffffffffffffffffff");
      expect(await as(u.admin, A, (tx) => repo.removeProject(tx, p4))).toBe(true);
    });

    const insertMember = (who: UserId, p: ProjectId, target: UserId, role: people.ProjectRole) =>
      as(who, A, (tx) => tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)", [A, p, target, role]));

    it("refuses people writes from viewers and editors", async () => {
      await expect(insertMember(u.viewer, p1, u.stranger, "viewer")).rejects.toThrow(/row-level security/);
      await expect(insertMember(u.editor, p1, u.stranger, "viewer")).rejects.toThrow(/row-level security/);
      const changed = await as(u.editor, A, (tx) =>
        tx.query("UPDATE supahound.project_members SET role = 'admin' WHERE project_id = $1 AND user_id = $2 RETURNING user_id", [p1, u.editor]));
      expect(changed).toEqual([]);
      const removed = await as(u.viewer, A, (tx) =>
        tx.query("DELETE FROM supahound.project_members WHERE project_id = $1 RETURNING user_id", [p1]));
      expect(removed).toEqual([]);
    });

    it("lets an admin manage every role but Owner, and only an owner manage Owners", async () => {
      await expect(insertMember(u.admin, p2, u.stranger, "owner")).rejects.toThrow(/row-level security/);
      await insertMember(u.admin, p2, u.stranger, "editor");
      // Promote to owner: admin refused (WITH CHECK), owner allowed.
      await expect(as(u.admin, A, (tx) => people.setPersonRole(tx, p2, u.stranger, "owner"))).rejects.toThrow(/row-level security/);
      expect(await as(u.owner, A, (tx) => people.setPersonRole(tx, p2, u.stranger, "owner"))).toBe(true);
      // Now an Owner row: the admin can neither change nor remove it.
      expect(await as(u.admin, A, (tx) => people.setPersonRole(tx, p2, u.stranger, "viewer"))).toBe(false);
      expect(await as(u.admin, A, (tx) => people.removePerson(tx, p2, u.stranger))).toBe(false);
      expect(await as(u.owner, A, (tx) => people.removePerson(tx, p2, u.stranger))).toBe(true);
      // That was the stranger's only project role, so they also left the workspace.
      await expect(withTenantForUser(db.app, u.stranger, A, async () => undefined)).rejects.toThrow(NotAMemberError);
    });

    it("refuses invites from viewers and editors, and Owner invites from admins", async () => {
      const invite = (who: UserId, role: people.ProjectRole) =>
        as(who, A, (tx) => people.createInvite(tx, {
          project: p1, email: `x-${randomUUID()}@agency.test`, role, invitedBy: who, tokenHash: people.inviteTokenHash(randomUUID()), now: NOW,
        }));
      await expect(invite(u.viewer, "viewer")).rejects.toThrow(/row-level security/);
      await expect(invite(u.editor, "viewer")).rejects.toThrow(/row-level security/);
      await expect(invite(u.admin, "owner")).rejects.toThrow(/row-level security/);
      expect(await invite(u.admin, "admin")).toBe("created");
      expect(await invite(u.owner, "owner")).toBe("created");
    });

    it("shows pending invites to owners and admins only", async () => {
      const seen = async (who: UserId) => (await as(who, A, (tx) => tx.query("SELECT id FROM supahound.project_invites WHERE project_id = $1", [p1]))).length;
      expect(await seen(u.owner)).toBeGreaterThan(0);
      expect(await seen(u.admin)).toBeGreaterThan(0);
      expect(await seen(u.editor)).toBe(0);
      expect(await seen(u.viewer)).toBe(0);
    });

    it("cannot add a role on another tenant's project, or for another tenant", async () => {
      // RLS refuses it first (no role on a project outside the tenant); the FK would too.
      await expect(insertMember(u.owner, pB, u.viewer, "viewer")).rejects.toThrow(/row-level security/);
      await expect(
        sys(A, (tx) => tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'viewer')", [A, pB, u.viewer])),
      ).rejects.toThrow(/foreign key/);
      await expect(
        as(u.owner, A, (tx) => tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'viewer')", [B, pB, u.owner])),
      ).rejects.toThrow(/row-level security/);
      // A user who is not a workspace member cannot hold a project role (FK to memberships).
      await expect(insertMember(u.owner, p1, user(), "viewer")).rejects.toThrow(/foreign key/);
    });
  });

  describe("invites", () => {
    async function invite(email: string, role: people.ProjectRole, project: ProjectId = p1, t: TenantId = A, by: UserId = u.owner) {
      const token = people.newInviteToken(t);
      const result = await as(by, t, (tx) => people.createInvite(tx, { project, email, role, invitedBy: by, tokenHash: people.inviteTokenHash(token), now: NOW }));
      return { token, result };
    }
    const accept = (token: string, who: UserId, email: string | null, now = NOW) => people.acceptInvite(db.app, { token, user: who, email, now });

    it("stores only the token's hash", async () => {
      const { token } = await invite("hash@new.test", "viewer");
      const rows = await db.admin.query("SELECT token_hash FROM supahound.project_invites WHERE email = 'hash@new.test'");
      expect(rows.rows).toEqual([{ token_hash: people.inviteTokenHash(token) }]);
      expect(JSON.stringify(rows.rows)).not.toContain(token.split(".")[1]);
    });

    it("lets the invited address accept once: workspace member, project role, that project only", async () => {
      const { token, result } = await invite("New.Person@Example.test", "editor");
      expect(result).toBe("created");
      const me = user();
      expect(await people.previewInvite(db.app, token, NOW)).toMatchObject({ projectId: p1, projectName: "Shop", role: "editor", state: "open", email: "new.person@example.test" });
      expect(await accept(token, me, "new.person@EXAMPLE.test")).toEqual({ status: "accepted", tenant: A, project: p1, role: "editor" });
      const ws = await withTenantForUser(db.app, me, A, async (tx, role) => ({ role, projects: (await repo.listProjects(tx)).map((p) => [p.name, p.role]) }));
      expect(ws).toEqual({ role: "member", projects: [["Shop", "editor"]] });
      const email = await db.admin.query("SELECT email FROM supahound.memberships WHERE tenant_id = $1 AND user_id = $2", [A, me]);
      expect(email.rows[0].email).toBe("new.person@EXAMPLE.test");
      // Single use: the same user, or anyone else, gets "used".
      expect(await accept(token, me, "new.person@example.test")).toEqual({ status: "used" });
      expect(await accept(token, user(), "new.person@example.test")).toEqual({ status: "used" });
      expect((await people.previewInvite(db.app, token, NOW))?.state).toBe("accepted");
    });

    it("refuses a signed-in user whose verified email is not the invited one, and writes nothing", async () => {
      const { token } = await invite("right@new.test", "viewer");
      const me = user();
      expect(await accept(token, me, "wrong@new.test")).toEqual({ status: "wrong_email" });
      expect(await accept(token, me, null)).toEqual({ status: "wrong_email" });
      expect(await accept(token, me, "right@new.test.evil")).toEqual({ status: "wrong_email" });
      const rows = await db.admin.query("SELECT 1 FROM supahound.memberships WHERE user_id = $1", [me]);
      expect(rows.rows).toEqual([]);
      expect((await people.previewInvite(db.app, token, NOW))?.state).toBe("open");
    });

    it("refuses an expired invite, and writes nothing", async () => {
      const { token } = await invite("late@new.test", "viewer");
      const me = user();
      const later = new Date(NOW.getTime() + people.INVITE_TTL_DAYS * 86_400_000 + 1000);
      const justBefore = new Date(NOW.getTime() + people.INVITE_TTL_DAYS * 86_400_000 - 1000);
      expect((await people.previewInvite(db.app, token, justBefore))?.state).toBe("open");
      expect(await accept(token, me, "late@new.test", later)).toEqual({ status: "expired" });
      expect((await db.admin.query("SELECT 1 FROM supahound.memberships WHERE user_id = $1", [me])).rows).toEqual([]);
    });

    it("refuses a canceled invite", async () => {
      const { token } = await invite("gone@new.test", "viewer");
      const [row] = (await db.admin.query("SELECT id FROM supahound.project_invites WHERE email = 'gone@new.test'")).rows;
      expect(await as(u.admin, A, (tx) => people.cancelInvite(tx, p1, row.id, NOW))).toBe(true);
      expect(await accept(token, user(), "gone@new.test")).toEqual({ status: "canceled" });
    });

    it("renews: a second invite to the same address or a resend kills the old link", async () => {
      const first = await invite("again@new.test", "viewer");
      const second = await invite("again@new.test", "editor");
      expect(second.result).toBe("renewed");
      expect(await as(u.admin, A, (tx) => people.openInviteFor(tx, p1, "AGAIN@new.test"))).toMatchObject({ email: "again@new.test", role: "editor" });
      expect(await as(u.admin, A, (tx) => people.openInviteFor(tx, p2, "again@new.test"))).toBeNull();
      expect(await accept(first.token, user(), "again@new.test")).toEqual({ status: "invalid" });
      const [row] = (await db.admin.query("SELECT id FROM supahound.project_invites WHERE email = 'again@new.test' AND accepted_at IS NULL")).rows;
      // A resend within a minute is refused; after it, a new token replaces the old one.
      const t3 = people.newInviteToken(A);
      expect(await as(u.owner, A, (tx) => people.renewInvite(tx, { project: p1, inviteId: row.id, tokenHash: people.inviteTokenHash(t3), now: NOW }))).toBe("cooldown");
      const later = new Date(NOW.getTime() + 61_000);
      expect(await as(u.owner, A, (tx) => people.renewInvite(tx, { project: p1, inviteId: row.id, tokenHash: people.inviteTokenHash(t3), now: later })))
        .toEqual({ id: row.id, email: "again@new.test", role: "editor" });
      expect(await accept(second.token, user(), "again@new.test")).toEqual({ status: "invalid" });
      expect((await accept(t3, user(), "again@new.test", later)).status).toBe("accepted");
    });

    it("refuses to invite someone who already has a role on the project, and a malformed address", async () => {
      expect((await invite("viewer@agency.test", "admin")).result).toBe("member");
      expect((await invite("OWNER@agency.test", "viewer")).result).toBe("member");
      expect((await invite("not an email", "viewer")).result).toBe("invalid");
    });

    it("binds the token to its tenant: another tenant's ID, a forged or malformed token find nothing", async () => {
      const { token } = await invite("bound@new.test", "viewer");
      const secret = token.split(".")[1]!;
      for (const bad of [`${B}.${secret}`, `${A}.${"A".repeat(43)}`, secret, "", `${A}.`, "'; DROP TABLE x; --"]) {
        expect(await accept(bad, user(), "bound@new.test"), bad).toEqual({ status: "invalid" });
        expect(await people.previewInvite(db.app, bad, NOW)).toBeNull();
      }
      expect(people.tenantFromInviteToken(token)).toBe(A);
    });

    it("never lowers a higher role when an invite is accepted", async () => {
      // The editor of p1 gets a viewer invite to p1 (sent to a second address, then pointed at
      // their own, since an invite to a person already on the project is refused): no change.
      const { token } = await invite("editor-second@agency.test", "viewer");
      await db.admin.query("UPDATE supahound.project_invites SET email = 'editor@agency.test' WHERE token_hash = $1", [people.inviteTokenHash(token)]);
      expect((await accept(token, u.editor, "editor@agency.test")).status).toBe("accepted");
      expect(await as(u.editor, A, (tx) => people.projectRole(tx, p1))).toBe("editor");
    });

    it("keeps a staff workspace's billing exemption when an invited Owner joins (decision 029)", async () => {
      const staff = user();
      const S = await createWorkspace(db.app, staff, "Staff", "me@staff.test");
      const pS = await addProject(S, "Staff app", "gggggggggggggggggggg");
      expect(await sys(S, (tx) => billing.grantExemption(tx, staff, NOW))).toBe(true);
      const { token } = await invite("friend@new.test", "owner", pS, S, staff);
      const friend = user();
      expect((await accept(token, friend, "friend@new.test")).status).toBe("accepted");
      expect(await as(friend, S, (tx) => people.projectRole(tx, pS))).toBe("owner");
      expect((await sys(S, (tx) => billing.getBilling(tx))).exempt).toBe(true);
      expect(await withTenantForUser(db.app, friend, S, async (_tx, role) => role)).toBe("member");
    });

    it("removing a person's last project role also removes their workspace membership", async () => {
      const { token } = await invite("leaver@new.test", "viewer");
      const leaver = user();
      await accept(token, leaver, "leaver@new.test");
      expect(await as(u.admin, A, (tx) => people.removePerson(tx, p1, leaver))).toBe(true);
      await expect(withTenantForUser(db.app, leaver, A, async () => undefined)).rejects.toThrow(NotAMemberError);
      // A workspace admin has no project row to remove.
      expect(await as(u.owner, A, (tx) => people.removePerson(tx, p1, u.admin))).toBe(false);
    });

    it("lists people with their effective role and source", async () => {
      const list = await as(u.viewer, A, (tx) => people.listPeople(tx, p1));
      const byEmail = Object.fromEntries(list.map((p) => [p.email, [p.role, p.source]]));
      expect(byEmail["owner@agency.test"]).toEqual(["owner", "workspace"]);
      expect(byEmail["admin@agency.test"]).toEqual(["admin", "workspace"]);
      expect(byEmail["editor@agency.test"]).toEqual(["editor", "project"]);
      expect(byEmail["viewer@agency.test"]).toEqual(["viewer", "project"]);
      expect(byEmail["stranger@agency.test"]).toBeUndefined();
      expect(list[0]!.role).toBe("owner");
    });
  });

  describe("alert recipients per project", () => {
    it("emails a project's people and the workspace owners and admins, never people of another project", async () => {
      const r1 = await sys(A, (tx) => repo.alertRecipients(tx, p1));
      const r2 = await sys(A, (tx) => repo.alertRecipients(tx, p2));
      expect(r1).toEqual(expect.arrayContaining(["owner@agency.test", "admin@agency.test", "editor@agency.test", "viewer@agency.test"]));
      expect(r1).not.toContain("stranger@agency.test");
      expect(r2).toEqual(["admin@agency.test", "owner@agency.test"]);
      expect(await sys(A, (tx) => repo.alertRecipients(tx, projectId(pB)))).toEqual(["admin@agency.test", "owner@agency.test"]);
      expect(await sys(B, (tx) => repo.alertRecipients(tx, pB))).toEqual(["owner@other.test"]);
    });
  });

  it("only accepts tenant-scoped tokens of the right shape", () => {
    const t = tenantId(randomUUID());
    const token = people.newInviteToken(t);
    expect(people.tenantFromInviteToken(token)).toBe(t);
    expect(people.tenantFromInviteToken(token.slice(0, -1))).toBeNull();
    expect(people.tenantFromInviteToken(`${token}x`)).toBeNull();
    expect(people.inviteTokenHash(token)).toMatch(/^[0-9a-f]{64}$/);
  });
});
