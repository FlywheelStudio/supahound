import { createHash, randomBytes } from "node:crypto";
import type { Pool } from "pg";
import { tenantId, type ProjectId, type TenantId, type UserId } from "../tenancy/scope.js";
import { isStorableEmail } from "./repo.js";
import { withTenant, type TenantTx } from "./tenant.js";
import type { Role } from "./user.js";

// People and roles per project (issue #24, decisions 033 and 036).
//
// The effective role comes from supahound.project_role() in SQL: a workspace owner is Owner and a
// workspace admin at least Admin on every project; anyone else has the role in project_members,
// or no access. RLS hides a project's rows from a signed-in user without a role, and refuses
// people and settings writes the role does not allow. The server actions check the same rules
// first (apps/web/lib/people.ts), so a refused write never reaches the database in normal use.

export type ProjectRole = "owner" | "admin" | "editor" | "viewer";
export const PROJECT_ROLES: readonly ProjectRole[] = ["owner", "admin", "editor", "viewer"];
export const ROLE_RANK: Record<ProjectRole, number> = { viewer: 1, editor: 2, admin: 3, owner: 4 };

export function isProjectRole(v: unknown): v is ProjectRole {
  return typeof v === "string" && (PROJECT_ROLES as readonly string[]).includes(v);
}

export const INVITE_TTL_DAYS = 7;
// A resend within this time is refused, so one admin cannot flood an inbox.
export const RESEND_COOLDOWN_SECONDS = 60;

// --- Invite tokens ---------------------------------------------------------------------------------
// "<tenant>.<43 chars base64url>": the tenant scopes the lookup (RLS needs app.tenant_id), the
// random part is the secret. Only sha256(token) is stored.

export function newInviteToken(tenant: TenantId): string {
  return `${tenant}.${randomBytes(32).toString("base64url")}`;
}

export function tenantFromInviteToken(token: string): TenantId | null {
  const m = /^([0-9a-f-]{36})\.([A-Za-z0-9_-]{43})$/.exec(token);
  if (!m) return null;
  try {
    return tenantId(m[1]!);
  } catch {
    return null;
  }
}

export const inviteTokenHash = (token: string): string => createHash("sha256").update(token).digest("hex");

const normalizeEmail = (email: string) => email.trim().toLowerCase();

// --- Reads inside a signed-in tenant transaction ---------------------------------------------------

export async function projectRole(tx: TenantTx, project: ProjectId): Promise<ProjectRole | null> {
  const [r] = await tx.query<{ role: string | null }>("SELECT supahound.project_role($1::uuid) AS role", [project]);
  return isProjectRole(r?.role) ? r.role : null;
}

export interface Person {
  userId: string;
  email: string | null;
  role: ProjectRole;
  workspaceRole: Role;
  // "workspace": a workspace owner or admin, whose project role follows from the workspace role
  // and is managed there. "project": a project_members row, managed on the People page.
  source: "workspace" | "project";
}

// Everyone with a role on the project, highest role first.
export async function listPeople(tx: TenantTx, project: ProjectId): Promise<Person[]> {
  const rows = await tx.query<{ user_id: string; email: string | null; workspace_role: Role; project_role: ProjectRole | null }>(
    `SELECT m.user_id, m.email, m.role AS workspace_role, pm.role AS project_role
     FROM supahound.memberships m
     LEFT JOIN supahound.project_members pm
       ON pm.tenant_id = m.tenant_id AND pm.project_id = $2 AND pm.user_id = m.user_id
     WHERE m.tenant_id = $1 AND (m.role IN ('owner', 'admin') OR pm.role IS NOT NULL)`,
    [tx.tenantId, project],
  );
  const people = rows.map((r): Person => {
    const fromWorkspace = r.workspace_role === "owner" ? "owner" : r.workspace_role === "admin" ? "admin" : null;
    const role = fromWorkspace === "admin" && r.project_role === "owner" ? "owner" : fromWorkspace ?? r.project_role!;
    return { userId: r.user_id, email: r.email, role, workspaceRole: r.workspace_role, source: fromWorkspace ? "workspace" : "project" };
  });
  return people.sort((a, b) => ROLE_RANK[b.role] - ROLE_RANK[a.role] || (a.email ?? "~").localeCompare(b.email ?? "~"));
}

export interface PendingInvite {
  id: string;
  email: string;
  role: ProjectRole;
  sentAt: Date;
  expiresAt: Date;
  expired: boolean;
}

// Open invites (not accepted, not canceled), expired ones included so they can be resent.
export async function listInvites(tx: TenantTx, project: ProjectId, now: Date): Promise<PendingInvite[]> {
  const rows = await tx.query<{ id: string; email: string; role: ProjectRole; sent_at: Date; expires_at: Date }>(
    `SELECT id, email, role, sent_at, expires_at FROM supahound.project_invites
     WHERE tenant_id = $1 AND project_id = $2 AND accepted_at IS NULL AND canceled_at IS NULL
     ORDER BY created_at, id`,
    [tx.tenantId, project],
  );
  return rows.map((r) => ({ id: r.id, email: r.email, role: r.role, sentAt: r.sent_at, expiresAt: r.expires_at, expired: r.expires_at <= now }));
}

// --- Writes inside a signed-in tenant transaction (the caller checks the actor's role first) -----

const expiry = (now: Date) => new Date(now.getTime() + INVITE_TTL_DAYS * 86_400_000);

export type CreateInviteResult = "created" | "renewed" | "member" | "invalid";

// Invites an address to the project. An open invite to the same address is renewed instead: new
// role, new token, new expiry; its old link stops working.
export async function createInvite(
  tx: TenantTx,
  input: { project: ProjectId; email: string; role: ProjectRole; invitedBy: UserId; tokenHash: string; now: Date },
): Promise<CreateInviteResult> {
  const email = normalizeEmail(input.email);
  if (!isStorableEmail(email)) return "invalid";
  const people = await listPeople(tx, input.project);
  if (people.some((p) => p.email !== null && normalizeEmail(p.email) === email)) return "member";
  const rows = await tx.query<{ inserted: boolean }>(
    `INSERT INTO supahound.project_invites (tenant_id, project_id, email, role, token_hash, invited_by, sent_at, expires_at)
     VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
     ON CONFLICT (tenant_id, project_id, email) WHERE accepted_at IS NULL AND canceled_at IS NULL
     DO UPDATE SET role = EXCLUDED.role, token_hash = EXCLUDED.token_hash, invited_by = EXCLUDED.invited_by,
                   sent_at = EXCLUDED.sent_at, expires_at = EXCLUDED.expires_at
     RETURNING (xmax = 0) AS inserted`,
    [tx.tenantId, input.project, email, input.role, input.tokenHash, input.invitedBy, input.now, expiry(input.now)],
  );
  return rows[0]?.inserted ? "created" : "renewed";
}

export interface OpenInvite {
  id: string;
  email: string;
  role: ProjectRole;
}

// The open invite to this address on the project, if any. A second invite renews it, so the
// actor must be allowed to grant ITS role too (an admin cannot rewrite a pending Owner invite).
export async function openInviteFor(tx: TenantTx, project: ProjectId, email: string): Promise<OpenInvite | null> {
  const [r] = await tx.query<OpenInvite>(
    `SELECT id, email, role FROM supahound.project_invites
     WHERE tenant_id = $1 AND project_id = $2 AND email = $3 AND accepted_at IS NULL AND canceled_at IS NULL`,
    [tx.tenantId, project, normalizeEmail(email)],
  );
  return r ?? null;
}

export async function getOpenInvite(tx: TenantTx, project: ProjectId, inviteId: string): Promise<OpenInvite | null> {
  const [r] = await tx.query<OpenInvite>(
    `SELECT id, email, role FROM supahound.project_invites
     WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND accepted_at IS NULL AND canceled_at IS NULL`,
    [tx.tenantId, project, inviteId],
  );
  return r ?? null;
}

// Sends an open invite again with a new token and a new 7-day expiry. "cooldown" when the last
// send was under a minute ago; null when there is no such open invite.
export async function renewInvite(
  tx: TenantTx,
  input: { project: ProjectId; inviteId: string; tokenHash: string; now: Date },
): Promise<OpenInvite | "cooldown" | null> {
  const [r] = await tx.query<OpenInvite & { recent: boolean }>(
    `SELECT id, email, role, sent_at > $4::timestamptz - make_interval(secs => $5) AS recent
     FROM supahound.project_invites
     WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND accepted_at IS NULL AND canceled_at IS NULL
     FOR UPDATE`,
    [tx.tenantId, input.project, input.inviteId, input.now, RESEND_COOLDOWN_SECONDS],
  );
  if (!r) return null;
  if (r.recent) return "cooldown";
  await tx.query(
    `UPDATE supahound.project_invites SET token_hash = $4, sent_at = $5, expires_at = $6
     WHERE tenant_id = $1 AND project_id = $2 AND id = $3`,
    [tx.tenantId, input.project, input.inviteId, input.tokenHash, input.now, expiry(input.now)],
  );
  return { id: r.id, email: r.email, role: r.role };
}

export async function cancelInvite(tx: TenantTx, project: ProjectId, inviteId: string, now: Date): Promise<boolean> {
  const rows = await tx.query(
    `UPDATE supahound.project_invites SET canceled_at = $4
     WHERE tenant_id = $1 AND project_id = $2 AND id = $3 AND accepted_at IS NULL AND canceled_at IS NULL RETURNING id`,
    [tx.tenantId, project, inviteId, now],
  );
  return rows.length === 1;
}

// Changes a person's project role. Only project_members rows: a workspace owner's or admin's
// role follows from the workspace.
export async function setPersonRole(tx: TenantTx, project: ProjectId, user: string, role: ProjectRole): Promise<boolean> {
  const rows = await tx.query(
    `UPDATE supahound.project_members SET role = $4 WHERE tenant_id = $1 AND project_id = $2 AND user_id = $3 RETURNING user_id`,
    [tx.tenantId, project, user, role],
  );
  return rows.length === 1;
}

// Removes a person from the project. A workspace member left with no project role also leaves
// the workspace, so they no longer see its name or get its email. Owners and admins stay.
export async function removePerson(tx: TenantTx, project: ProjectId, user: string): Promise<boolean> {
  const rows = await tx.query(
    "DELETE FROM supahound.project_members WHERE tenant_id = $1 AND project_id = $2 AND user_id = $3 RETURNING user_id",
    [tx.tenantId, project, user],
  );
  if (rows.length !== 1) return false;
  await tx.query(
    `DELETE FROM supahound.memberships m
     WHERE m.tenant_id = $1 AND m.user_id = $2 AND m.role = 'member'
       AND NOT EXISTS (SELECT 1 FROM supahound.project_members pm WHERE pm.tenant_id = m.tenant_id AND pm.user_id = m.user_id)`,
    [tx.tenantId, user],
  );
  return true;
}

// --- The invitee's side: before they are a member --------------------------------------------------
// These run in a tenant transaction WITHOUT app.user_id, because the invitee has no role yet.
// The token hash is the only key: nothing is read or written without a matching, open invite,
// and acceptance also requires the invitee's verified email to match the invited address.

export type InviteState = "open" | "expired" | "accepted" | "canceled";

export interface InvitePreview {
  projectId: ProjectId;
  projectName: string;
  email: string;
  role: ProjectRole;
  state: InviteState;
  expiresAt: Date;
}

function stateOf(r: { accepted_at: Date | null; canceled_at: Date | null; expires_at: Date }, now: Date): InviteState {
  if (r.accepted_at) return "accepted";
  if (r.canceled_at) return "canceled";
  return r.expires_at <= now ? "expired" : "open";
}

export async function previewInvite(pool: Pool, token: string, now: Date): Promise<InvitePreview | null> {
  const tenant = tenantFromInviteToken(token);
  if (!tenant) return null;
  return withTenant(pool, tenant, async (tx) => {
    const [r] = await tx.query<{
      project_id: ProjectId; name: string; email: string; role: ProjectRole;
      accepted_at: Date | null; canceled_at: Date | null; expires_at: Date;
    }>(
      `SELECT i.project_id, p.name, i.email, i.role, i.accepted_at, i.canceled_at, i.expires_at
       FROM supahound.project_invites i
       JOIN supahound.projects p ON p.tenant_id = i.tenant_id AND p.id = i.project_id
       WHERE i.tenant_id = $1 AND i.token_hash = $2`,
      [tenant, inviteTokenHash(token)],
    );
    if (!r) return null;
    return { projectId: r.project_id, projectName: r.name, email: r.email, role: r.role, state: stateOf(r, now), expiresAt: r.expires_at };
  });
}

export type AcceptResult =
  | { status: "accepted"; tenant: TenantId; project: ProjectId; role: ProjectRole }
  | { status: "invalid" | "expired" | "used" | "canceled" | "wrong_email" };

// Accepts an invite, once. In one transaction: lock the invite, check it is open and unexpired
// and that the verified email matches, add the workspace membership (as "member") if missing,
// add the project role (never lowering a higher one), and mark the invite used.
export async function acceptInvite(
  pool: Pool,
  input: { token: string; user: UserId; email: string | null; now: Date },
): Promise<AcceptResult> {
  const tenant = tenantFromInviteToken(input.token);
  if (!tenant) return { status: "invalid" };
  return withTenant(pool, tenant, async (tx) => {
    const [r] = await tx.query<{
      id: string; project_id: ProjectId; email: string; role: ProjectRole;
      accepted_at: Date | null; canceled_at: Date | null; expires_at: Date;
    }>(
      `SELECT id, project_id, email, role, accepted_at, canceled_at, expires_at FROM supahound.project_invites
       WHERE tenant_id = $1 AND token_hash = $2 FOR UPDATE`,
      [tenant, inviteTokenHash(input.token)],
    );
    if (!r) return { status: "invalid" };
    const state = stateOf(r, input.now);
    if (state === "accepted") return { status: "used" };
    if (state !== "open") return { status: state };
    if (input.email === null || normalizeEmail(input.email) !== r.email) return { status: "wrong_email" };

    await tx.query(
      `INSERT INTO supahound.memberships (tenant_id, user_id, role, email) VALUES ($1, $2, 'member', $3)
       ON CONFLICT (tenant_id, user_id) DO UPDATE SET email = COALESCE(supahound.memberships.email, EXCLUDED.email)`,
      [tenant, input.user, isStorableEmail(input.email) ? input.email : null],
    );
    await tx.query(
      `INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)
       ON CONFLICT (tenant_id, project_id, user_id) DO UPDATE
         SET role = CASE WHEN array_position(ARRAY['viewer','editor','admin','owner'], EXCLUDED.role)
                            > array_position(ARRAY['viewer','editor','admin','owner'], supahound.project_members.role)
                         THEN EXCLUDED.role ELSE supahound.project_members.role END`,
      [tenant, r.project_id, input.user, r.role],
    );
    await tx.query(
      "UPDATE supahound.project_invites SET accepted_at = $3, accepted_by = $4 WHERE tenant_id = $1 AND id = $2",
      [tenant, r.id, input.now, input.user],
    );
    return { status: "accepted", tenant, project: r.project_id, role: r.role };
  });
}
