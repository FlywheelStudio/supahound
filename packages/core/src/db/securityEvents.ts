import type { Pool } from "pg";
import { checkWindowDays, STANDARD_SECURITY_EVENT_DAYS } from "../billing/history.js";
import { opsLine, opsLog } from "../logging/opsLog.js";
import type { ProjectId, UserId } from "../tenancy/scope.js";
import { begin, type TenantTx } from "./tenant.js";

// Supahound's own security events (issue #138, decision 044; ASVS 16.3).
//
// Two sinks:
//   * supahound.security_events, for events that belong to a workspace: sign-ins, invites, role
//     changes, member removals, Supabase connections, project changes, closing and data deletion.
//     Written in the same transaction as the change it records, so a rolled-back change leaves no
//     row. Only workspace owners read it (RLS owner_read), on Workspace settings → Security log.
//   * Workers logs, for events with no workspace to file them under (a CSRF 403, a bad Send Email
//     Hook signature, a rejected OAuth state, a non-member 404): one line of JSON with an enum.
//
// Neither sink holds personal data beyond user IDs: no email, IP, user agent or free text. The
// detail is a small object of allow-listed keys whose strings are enums (safeDetail).

export const SECURITY_ACTIONS = [
  "sign_in",
  "invite_sent", "invite_accepted", "invite_revoked",
  "role_changed", "member_removed",
  "connection_added", "connection_removed",
  "project_added", "project_removed", "project_kept",
  "workspace_closed", "workspace_reopened",
  "data_deleted",
] as const;
export type SecurityAction = (typeof SECURITY_ACTIONS)[number];

export const SECURITY_RESULTS = ["success", "denied", "failed"] as const;
export type SecurityResult = (typeof SECURITY_RESULTS)[number];

// The standard window: kept this long once the workspace stops paying (decision 044, following
// 037: nothing is deleted while it pays). The Security log page shows the same window. Enterprise
// workspaces get a year (decision 048): callers pass the plan's window (billing/history.ts).
export const SECURITY_EVENT_DAYS = STANDARD_SECURITY_EVENT_DAYS;

// --- Detail: allow-listed keys, enum strings, counts and flags -------------------------------------

export type DetailValue = string | number | boolean;
export type SecurityDetail = Partial<Record<DetailKey, DetailValue>>;

const DETAIL_KEYS = ["role", "from", "kind", "reason", "count", "projects", "reattached", "revoked", "method"] as const;
type DetailKey = (typeof DETAIL_KEYS)[number];
// An enum value: lower case, digits and underscores. An email (@), IP (dots, colons), user agent
// (spaces, slashes) or any free text fails it.
const ENUM = /^[a-z][a-z0-9_]{0,39}$/;

// Throws on anything outside the rules: a bug in a caller, which a test should catch, never a
// value to store.
export function safeDetail(detail: Record<string, unknown> | undefined): SecurityDetail {
  const out: SecurityDetail = {};
  for (const [key, value] of Object.entries(detail ?? {})) {
    if (value === undefined) continue;
    if (!(DETAIL_KEYS as readonly string[]).includes(key)) throw new TypeError(`security event detail: unknown key ${key}`);
    const ok =
      typeof value === "boolean" ||
      (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) ||
      (typeof value === "string" && ENUM.test(value));
    if (!ok) throw new TypeError(`security event detail: ${key} is not an enum, count or flag`);
    out[key as DetailKey] = value as DetailValue;
  }
  return out;
}

// --- Writes ------------------------------------------------------------------------------------------

export interface SecurityEventInput {
  action: SecurityAction;
  result?: SecurityResult;
  // The signed-in user (verified JWT) or null for Supahound itself. RLS requires it to equal
  // app.user_id when that is set.
  actor: UserId | null;
  project?: ProjectId | null;
  // The person, invite, connection or project acted on (a UUID).
  target?: string | null;
  detail?: Record<string, unknown>;
}

// Records one event in the caller's tenant transaction, so it commits or rolls back with the change.
export async function recordSecurityEvent(tx: TenantTx, e: SecurityEventInput): Promise<void> {
  await tx.query(
    `INSERT INTO supahound.security_events (tenant_id, project_id, actor_user_id, action, target_id, result, detail)
     VALUES ($1, $2, $3, $4, $5, $6, $7)`,
    [tx.tenantId, e.project ?? null, e.actor, e.action, e.target ?? null, e.result ?? "success", JSON.stringify(safeDetail(e.detail))],
  );
}

// A sign-in, recorded in every workspace the user belongs to, in one statement. Runs with only
// app.user_id set: RLS (own_sign_in) allows exactly this row, as this user, in their own
// workspaces. A user with no workspace yet adds nothing. Returns the number of rows.
export async function recordSignIn(pool: Pool, user: UserId): Promise<number> {
  const client = await pool.connect();
  try {
    await begin(client, { "app.user_id": user });
    const res = await client.query(
      `INSERT INTO supahound.security_events (tenant_id, actor_user_id, action, result)
       SELECT m.tenant_id, $1, 'sign_in', 'success' FROM supahound.memberships m WHERE m.user_id = $1`,
      [user],
    );
    await client.query("COMMIT");
    return res.rowCount ?? 0;
  } catch (err) {
    await client.query("ROLLBACK").catch(() => undefined);
    throw err;
  } finally {
    client.release();
  }
}

// The daily data job, for a workspace that does not pay: events older than the window go.
export async function deleteExpiredSecurityEvents(tx: TenantTx, now: Date, days: number): Promise<number> {
  const rows = await tx.query(
    `DELETE FROM supahound.security_events
     WHERE tenant_id = $1 AND created_at < $2::timestamptz - make_interval(days => $3::int)
     RETURNING id`,
    [tx.tenantId, now, checkWindowDays(days)],
  );
  return rows.length;
}

// --- Reads (workspace owners only; RLS owner_read returns nothing to anyone else) ----------------

// Keyset position: epoch microseconds as a decimal string, read from SQL (a JS Date would drop
// the microseconds and skip rows), and the row ID.
export interface SecurityEventCursor {
  createdUs: string;
  id: string;
}

export interface SecurityEventItem {
  id: string;
  action: SecurityAction;
  result: SecurityResult;
  createdAt: Date;
  actorId: string | null;
  // The actor's or target's address while they are still in the workspace (memberships.email);
  // the event row itself never holds one.
  actorEmail: string | null;
  projectId: string | null;
  projectName: string | null;
  targetId: string | null;
  targetEmail: string | null;
  detail: SecurityDetail;
}

interface EventRow {
  id: string; action: SecurityAction; result: SecurityResult; created_at: Date; actor_user_id: string | null;
  actor_email: string | null; project_id: string | null; project_name: string | null; target_id: string | null;
  target_email: string | null; detail: unknown; created_us: string;
}

const US_TO_TS = (param: string) => `(timestamptz 'epoch' + ${param}::bigint * interval '1 microsecond')`;

// Only allow-listed keys with valid values come back out, whatever the column holds.
function detailOf(stored: unknown): SecurityDetail {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return {};
  const out: SecurityDetail = {};
  for (const [k, v] of Object.entries(stored as Record<string, unknown>)) {
    try {
      Object.assign(out, safeDetail({ [k]: v }));
    } catch {
      // skip
    }
  }
  return out;
}

// The workspace's events in the window, newest first. Pass the previous page's `next` as `after`.
export async function listSecurityEvents(
  tx: TenantTx,
  opts: { now: Date; days: number; limit: number; after?: SecurityEventCursor | null },
): Promise<{ events: SecurityEventItem[]; next: SecurityEventCursor | null }> {
  const limit = Math.max(1, Math.min(100, Math.trunc(opts.limit)));
  const after = opts.after ?? null;
  const rows = await tx.query<EventRow>(
    `SELECT e.id, e.action, e.result, e.created_at, e.actor_user_id, a.email AS actor_email,
            e.project_id, p.name AS project_name, e.target_id, t.email AS target_email, e.detail,
            ((extract(epoch FROM e.created_at) * 1000000)::numeric(20,0))::text AS created_us
     FROM supahound.security_events e
     LEFT JOIN supahound.memberships a ON a.tenant_id = e.tenant_id AND a.user_id = e.actor_user_id
     LEFT JOIN supahound.memberships t ON t.tenant_id = e.tenant_id AND t.user_id = e.target_id
     LEFT JOIN supahound.projects p ON p.tenant_id = e.tenant_id AND p.id = e.project_id
     WHERE e.tenant_id = $1 AND e.created_at >= $2::timestamptz - make_interval(days => $6::int)
       AND ($3::text IS NULL OR (e.created_at, e.id) < (${US_TO_TS("$3")}, $4::uuid))
     ORDER BY e.created_at DESC, e.id DESC
     LIMIT $5`,
    [tx.tenantId, opts.now, after?.createdUs ?? null, after?.id ?? null, limit + 1, checkWindowDays(opts.days)],
  );
  const page = rows.slice(0, limit);
  const last = page.at(-1);
  return {
    events: page.map((r) => ({
      id: r.id, action: r.action, result: r.result, createdAt: r.created_at, actorId: r.actor_user_id, actorEmail: r.actor_email,
      projectId: r.project_id, projectName: r.project_name, targetId: r.target_id, targetEmail: r.target_email, detail: detailOf(r.detail),
    })),
    next: rows.length > limit && last ? { createdUs: last.created_us, id: last.id } : null,
  };
}

// --- Events with no workspace: Workers logs ----------------------------------------------------------

export const TENANTLESS_EVENTS = [
  // A state-changing request from another origin (middleware).
  "csrf_rejected",
  // A Send Email Hook call whose Standard Webhooks signature failed.
  "email_hook_bad_signature",
  // An OAuth callback whose state was malformed, unknown, used, expired or someone else's.
  "oauth_state_rejected",
  // A signed-in user opened a workspace they do not belong to (answered 404).
  "non_member",
  // A workspace member opened a project they have no role on (answered 404).
  "no_project_role",
  // A sign-in link that did not verify (bad, used or expired).
  "sign_in_failed",
  // An invite token that matches no invite.
  "invite_token_invalid",
] as const;
export type TenantlessEvent = (typeof TENANTLESS_EVENTS)[number];

// One line of JSON on the Workers log, through opsLog (decision 047), which also takes it to R2.
// Fields follow safeDetail's rules, so nothing personal can be passed; a detail that breaks them
// is left out. Never throws: logging must not break the request it describes.
export function logSecurityEvent(kind: TenantlessEvent, fields?: SecurityDetail, log?: (line: string) => void): void {
  let detail: SecurityDetail = {};
  try {
    detail = safeDetail(fields);
  } catch {
    // The kind alone.
  }
  if (log) log(opsLine("security_event", { kind, ...detail }));
  else opsLog("security_event", { kind, ...detail });
}
