import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it, vi } from "vitest";
import { disconnectConnection, runDataJob } from "../../src/datacontrols/flow.js";
import * as people from "../../src/db/people.js";
import * as repo from "../../src/db/repo.js";
import {
  deleteExpiredSecurityEvents, listSecurityEvents, logSecurityEvent, recordSecurityEvent, recordSignIn, safeDetail, SECURITY_EVENT_DAYS,
  type SecurityEventCursor,
} from "../../src/db/securityEvents.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import { verifiedUserId, type ConnectionId, type ProjectId, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

// Supahound's own security events (issue #138, decision 044): owner-only reads enforced by RLS,
// append-only for signed-in users, sign-in rows only into the user's own workspaces, retention,
// keyset pages, and nothing personal in a row or a log line.

const DAY = 86_400_000;
const user = () => verifiedUserId(randomUUID());

describe.skipIf(pgInfo === null)("security events in Postgres", () => {
  const db = useDb();
  const u = { owner: user(), admin: user(), member: user(), stranger: user() };
  let A: TenantId;
  let B: TenantId;
  let project: ProjectId;
  let connection: ConnectionId;

  const as = <T>(who: UserId, t: TenantId, fn: Parameters<typeof withTenantForUser<T>>[3]) => withTenantForUser(db.app, who, t, fn);
  const sys = <T>(t: TenantId, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, t, fn);
  const count = async (t: TenantId, where = "true") =>
    (await db.admin.query<{ n: number }>(`SELECT count(*)::int AS n FROM supahound.security_events WHERE tenant_id = $1 AND ${where}`, [t])).rows[0]!.n;

  beforeAll(async () => {
    A = await createWorkspace(db.app, u.owner, "Alpha", "owner@alpha.test");
    B = await createWorkspace(db.app, u.stranger, "Beta", "stranger@beta.test");
    await sys(A, async (tx) => {
      await tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role, email) VALUES ($1, $2, 'admin', 'admin@alpha.test'), ($1, $3, 'member', 'member@alpha.test')", [A, u.admin, u.member]);
      connection = await repo.createConnection(tx, db.vault, { label: "Alpha org", token: "token-alpha" });
      project = await repo.createProject(tx, { connectionId: connection, supabaseRef: "secevtsabcdefghijklm", name: "Shop" });
      await tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'viewer')", [A, project, u.member]);
    });
    await sys(A, (tx) => recordSecurityEvent(tx, { action: "project_added", actor: u.owner, project, target: project }));
    await sys(B, (tx) => recordSecurityEvent(tx, { action: "workspace_closed", actor: u.stranger }));
  });

  it("shows the events to workspace owners only, by RLS, not just by the page", async () => {
    const read = (who: UserId) => as(who, A, (tx) => tx.query("SELECT action FROM supahound.security_events"));
    expect((await read(u.owner)).length).toBeGreaterThan(0);
    expect(await read(u.admin)).toEqual([]);
    expect(await read(u.member)).toEqual([]);
    // The core reader goes through the same policy.
    expect((await as(u.admin, A, (tx) => listSecurityEvents(tx, { now: new Date(), limit: 10 }))).events).toEqual([]);
    // Another tenant's owner sees only their own workspace.
    const theirs = await as(u.stranger, B, (tx) => tx.query<{ tenant_id: string }>("SELECT tenant_id FROM supahound.security_events"));
    expect(theirs.map((r) => r.tenant_id)).toEqual([B]);
  });

  it("lets admins and members write their own events, but never as someone else", async () => {
    await as(u.admin, A, (tx) => recordSecurityEvent(tx, { action: "project_removed", result: "denied", actor: u.admin, project, detail: { reason: "role" } }));
    await as(u.member, A, (tx) => recordSecurityEvent(tx, { action: "invite_sent", result: "denied", actor: u.member, project, detail: { role: "admin", reason: "role" } }));
    expect(await count(A, `actor_user_id IN ('${u.admin}', '${u.member}')`)).toBe(2);
    for (const actor of [u.owner, null]) {
      await expect(as(u.member, A, (tx) => recordSecurityEvent(tx, { action: "sign_in", actor }))).rejects.toThrow(/row-level security/);
    }
    // Cross-tenant: a row for another workspace, from inside this one.
    await expect(as(u.owner, A, (tx) => tx.query(
      "INSERT INTO supahound.security_events (tenant_id, actor_user_id, action, result) VALUES ($1, $2, 'sign_in', 'success')", [B, u.owner],
    ))).rejects.toThrow(/row-level security/);
  });

  it("is append-only for signed-in users: no update at all, and deletes match nothing", async () => {
    const before = await count(A);
    await expect(as(u.owner, A, (tx) => tx.query("UPDATE supahound.security_events SET result = 'success'"))).rejects.toThrow(/permission denied/);
    const deleted = await as(u.owner, A, (tx) => tx.query("DELETE FROM supahound.security_events RETURNING id"));
    expect(deleted).toEqual([]);
    expect(await count(A)).toBe(before);
    await expect(sys(A, (tx) => tx.query("UPDATE supahound.security_events SET result = 'success'"))).rejects.toThrow(/permission denied/);
  });

  it("refuses unknown actions, results and oversized detail in the database too", async () => {
    const raw = (action: string, result: string, detail: string) =>
      sys(A, (tx) => tx.query("INSERT INTO supahound.security_events (tenant_id, action, result, detail) VALUES ($1, $2, $3, $4::jsonb)", [A, action, result, detail]));
    await expect(raw("logged_in", "success", "{}")).rejects.toThrow(/check constraint/);
    await expect(raw("sign_in", "maybe", "{}")).rejects.toThrow(/check constraint/);
    await expect(raw("sign_in", "success", "[]")).rejects.toThrow(/check constraint/);
    await expect(raw("sign_in", "success", JSON.stringify({ kind: "x".repeat(600) }))).rejects.toThrow(/check constraint/);
  });

  it("records a sign-in in each of the user's workspaces and nowhere else", async () => {
    const before = { a: await count(A, "action = 'sign_in'"), b: await count(B, "action = 'sign_in'") };
    expect(await recordSignIn(db.app, u.admin)).toBe(1);
    expect(await count(A, `action = 'sign_in' AND actor_user_id = '${u.admin}'`)).toBe(1);
    expect(await count(B, "action = 'sign_in'")).toBe(before.b);
    // A second workspace: one row in each.
    await sys(B, (tx) => tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [B, u.admin]));
    expect(await recordSignIn(db.app, u.admin)).toBe(2);
    expect(await count(B, `action = 'sign_in' AND actor_user_id = '${u.admin}'`)).toBe(1);
    await sys(B, (tx) => tx.query("DELETE FROM supahound.memberships WHERE tenant_id = $1 AND user_id = $2", [B, u.admin]));
    // No workspace yet: nothing.
    expect(await recordSignIn(db.app, user())).toBe(0);
    expect(before.a).toBe(0);
  });

  it("allows nothing but the user's own sign-in through the tenant-less policy", async () => {
    const client = await db.app.connect();
    const attempt = async (sql: string, params: unknown[]) => {
      await client.query("BEGIN");
      await client.query("SELECT set_config('app.user_id', $1, true)", [u.member]);
      try {
        await client.query(sql, params);
      } finally {
        await client.query("ROLLBACK");
      }
    };
    try {
      const insert = "INSERT INTO supahound.security_events (tenant_id, actor_user_id, action, result, project_id) VALUES ($1, $2, $3, $4, $5)";
      await expect(attempt(insert, [B, u.member, "sign_in", "success", null])).rejects.toThrow(/row-level security/);
      await expect(attempt(insert, [A, u.owner, "sign_in", "success", null])).rejects.toThrow(/row-level security/);
      await expect(attempt(insert, [A, u.member, "workspace_closed", "success", null])).rejects.toThrow(/row-level security/);
      await expect(attempt(insert, [A, u.member, "sign_in", "denied", null])).rejects.toThrow(/row-level security/);
      await expect(attempt(insert, [A, u.member, "sign_in", "success", project])).rejects.toThrow(/row-level security/);
      await attempt(insert, [A, u.member, "sign_in", "success", null]);
    } finally {
      client.release();
    }
  });

  it("pages newest first by keyset, keeping rows that differ only in microseconds", async () => {
    const T = await createWorkspace(db.app, u.owner, "Paging");
    const base = "2026-11-20 10:00:00.123";
    await sys(T, (tx) => tx.query(
      `INSERT INTO supahound.security_events (tenant_id, actor_user_id, action, result, created_at)
       SELECT $1, $2, 'sign_in', 'success', ($3 || lpad(g::text, 3, '0'))::timestamptz
       FROM generate_series(1, 7) g`,
      [T, u.owner, base],
    ));
    const now = new Date("2026-11-22T00:00:00Z");
    const seen: string[] = [];
    let after: SecurityEventCursor | null = null;
    for (let i = 0; i < 5; i++) {
      const page = await as(u.owner, T, (tx) => listSecurityEvents(tx, { now, limit: 3, after }));
      seen.push(...page.events.map((e) => e.id));
      if (!page.next) break;
      after = page.next;
    }
    expect(seen).toHaveLength(7);
    expect(new Set(seen).size).toBe(7);
    const ordered = (await db.admin.query<{ id: string }>("SELECT id FROM supahound.security_events WHERE tenant_id = $1 ORDER BY created_at DESC, id DESC", [T])).rows.map((r) => r.id);
    expect(seen).toEqual(ordered);
    // Outside the 90-day window: not listed.
    const later = new Date(now.getTime() + (SECURITY_EVENT_DAYS + 3) * DAY);
    expect((await as(u.owner, T, (tx) => listSecurityEvents(tx, { now: later, limit: 10 }))).events).toEqual([]);
  });

  it("shows member addresses and project names from their own tables, never from the row", async () => {
    await as(u.owner, A, (tx) => recordSecurityEvent(tx, { action: "role_changed", actor: u.owner, project, target: u.member, detail: { role: "editor", from: "viewer" } }));
    const { events } = await as(u.owner, A, (tx) => listSecurityEvents(tx, { now: new Date(), limit: 50 }));
    const e = events.find((x) => x.action === "role_changed")!;
    expect(e).toMatchObject({ actorEmail: "owner@alpha.test", targetEmail: "member@alpha.test", projectName: "Shop", detail: { role: "editor", from: "viewer" } });
    const stored = (await db.admin.query("SELECT detail::text AS d FROM supahound.security_events WHERE tenant_id = $1", [A])).rows.map((r) => r.d).join(" ");
    expect(stored).not.toMatch(/@/);
  });

  it("deletes events older than 90 days only by the system, and the data job only while the workspace does not pay", async () => {
    const T = await createWorkspace(db.app, u.owner, "Retention");
    const now = new Date();
    const at = (days: number) => new Date(now.getTime() - days * DAY);
    await sys(T, (tx) => tx.query(
      "INSERT INTO supahound.security_events (tenant_id, action, result, created_at) VALUES ($1, 'sign_in', 'success', $2), ($1, 'sign_in', 'success', $3)",
      [T, at(SECURITY_EVENT_DAYS + 1), at(SECURITY_EVENT_DAYS - 1)],
    ));
    // A paying workspace keeps everything (decision 037).
    await db.admin.query("INSERT INTO supahound.billing_accounts (tenant_id, status) VALUES ($1, 'active') ON CONFLICT (tenant_id) DO UPDATE SET status = 'active'", [T]);
    await runDataJob(db.app, T, now);
    expect(await count(T)).toBe(2);
    await db.admin.query("UPDATE supahound.billing_accounts SET status = 'canceled' WHERE tenant_id = $1", [T]);
    await runDataJob(db.app, T, now);
    expect(await count(T)).toBe(1);
    expect(await sys(T, (tx) => deleteExpiredSecurityEvents(tx, now))).toBe(0);
  });

  it("records a disconnect, and an admin refused by role, in the same transaction as the change", async () => {
    const T = await createWorkspace(db.app, u.owner, "Disconnect");
    await sys(T, (tx) => tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [T, u.member]));
    const conn = await sys(T, (tx) => repo.createConnection(tx, db.vault, { label: "Org", token: JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: 0 }) }));
    const deps = { pool: db.app, vault: db.vault, revoke: null };
    expect((await disconnectConnection(deps, { user: u.member, tenant: T, connection: conn, typedLabel: "Org" })).result).toBe("role");
    expect((await disconnectConnection(deps, { user: u.owner, tenant: T, connection: conn, typedLabel: "Org" })).result).toBe("disconnected");
    const rows = (await db.admin.query("SELECT action, result, actor_user_id, target_id, detail FROM supahound.security_events WHERE tenant_id = $1 ORDER BY created_at", [T])).rows;
    expect(rows).toEqual([
      { action: "connection_removed", result: "denied", actor_user_id: u.member, target_id: conn, detail: { reason: "role" } },
      { action: "connection_removed", result: "success", actor_user_id: u.owner, target_id: conn, detail: { reason: "user", projects: 0, revoked: false } },
    ]);
  });

  it("records each outcome of an invite acceptance on a real invite", async () => {
    const invitee = user();
    const token = people.newInviteToken(A);
    const now = new Date();
    await sys(A, (tx) => people.createInvite(tx, { project, email: "new@alpha.test", role: "editor", invitedBy: u.owner, tokenHash: people.inviteTokenHash(token), now }));
    expect((await people.acceptInvite(db.app, { token, user: invitee, email: "wrong@alpha.test", now })).status).toBe("wrong_email");
    expect((await people.acceptInvite(db.app, { token, user: invitee, email: "new@alpha.test", now })).status).toBe("accepted");
    expect((await people.acceptInvite(db.app, { token, user: invitee, email: "new@alpha.test", now })).status).toBe("used");
    const rows = (await db.admin.query("SELECT result, detail->>'reason' AS reason FROM supahound.security_events WHERE tenant_id = $1 AND action = 'invite_accepted' ORDER BY created_at", [A])).rows;
    expect(rows).toEqual([{ result: "denied", reason: "wrong_email" }, { result: "success", reason: null }, { result: "denied", reason: "used" }]);
  });
});

describe("security event detail and log lines carry no personal data", () => {
  it("keeps enums, counts and flags and refuses emails, IPs, user agents and unknown keys", () => {
    expect(safeDetail({ role: "editor", count: 3, revoked: false, kind: undefined })).toEqual({ role: "editor", count: 3, revoked: false });
    for (const bad of [{ role: "a@b.test" }, { reason: "203.0.113.7" }, { kind: "Mozilla/5.0 (X11)" }, { count: -1 }, { count: 1.5 }, { email: "x" }, { reason: "Role" }]) {
      expect(() => safeDetail(bad), JSON.stringify(bad)).toThrow(TypeError);
    }
  });

  it("writes one JSON line with the event enum, and drops fields that break the rules", () => {
    const lines: string[] = [];
    logSecurityEvent("csrf_rejected", { method: "post" }, (l) => lines.push(l));
    logSecurityEvent("oauth_state_rejected", { reason: "someone@example.test" } as never, (l) => lines.push(l));
    expect(lines.map((l) => JSON.parse(l))).toEqual([
      { event: "security_event", kind: "csrf_rejected", method: "post" },
      { event: "security_event", kind: "oauth_state_rejected" },
    ]);
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    logSecurityEvent("non_member");
    expect(spy).toHaveBeenCalledWith('{"event":"security_event","kind":"non_member"}');
    spy.mockRestore();
  });
});
