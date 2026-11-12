import type { Pool } from "pg";
import type { StripeGateway } from "../billing/flow.js";
import { accessFor } from "../billing/policy.js";
import { isLive, type ProjectSub } from "../billing/projects.js";
import { projectSubFromStripe, type StripeSubscription } from "../billing/stripeMap.js";
import {
  getBilling, isPaying, listProjectSubscriptions, refreshStanding, saveProjectSubscription, saveSubscription, watchedProjects,
  type SubscriptionSnapshot,
} from "../db/billing.js";
import { deferPurge, getClosure, purgeHistory, recordClosure, reopenWorkspace, type ReopenResult } from "../db/closure.js";
import { deferConnectionDeletes, deleteExpiredConnections, markDisconnected, type Disconnected } from "../db/connections.js";
import { appendAudit } from "../db/repo.js";
import { applyRetention, type RetentionResult } from "../db/retention.js";
import { withTenant, type TenantTx } from "../db/tenant.js";
import { withTenantForUser } from "../db/user.js";
import { parseCredentials } from "../supabase/oauth.js";
import type { ConnectionId, TenantId, UserId } from "../tenancy/scope.js";
import type { TokenVault } from "../vault/vault.js";
import { renderDisconnectEmail } from "./email.js";

// Data controls (issue #43, decision 037): close and reopen a workspace, disconnect a Supabase
// connection, and the daily data job. No external call (Stripe, Supabase, email) runs inside a
// tenant transaction: read and check, close, call, then write in a new transaction that checks
// again. Nothing is deleted while the workspace pays (billing/policy.ts payingAccount).

// The typed confirmation must match exactly, apart from surrounding spaces (decision 022's rule).
export const confirms = (typed: string, expected: string): boolean => typed.trim() === expected;

async function workspaceName(tx: TenantTx): Promise<string> {
  const [t] = await tx.query<{ name: string }>("SELECT name FROM supahound.tenants WHERE id = $1", [tx.tenantId]);
  return t?.name ?? "your workspace";
}

export type CloseResult = "closed" | "already_closed" | "role" | "mismatch";

export interface CloseDeps {
  pool: Pool;
  // Null when billing is off (self-hosting): nothing to cancel.
  stripe: Pick<StripeGateway, "setCancelAtPeriodEnd"> | null;
  now: () => Date;
}

const ENDED = new Set(["canceled", "incomplete_expired"]);

// The end of the period a closing workspace has paid (or trials) for; null when it has none.
function paidUntil(s: Pick<SubscriptionSnapshot, "status" | "currentPeriodEnd" | "trialEnd">): Date | null {
  if (accessFor(s.status) === "blocked") return null;
  return s.currentPeriodEnd ?? s.trialEnd;
}

// The end of the latest period a closing per-project workspace has paid (or trials) for (decision
// 041): every project subscription cancels at its own period end, and the workspace works until
// the last one ends.
function projectsPaidUntil(subs: readonly Pick<ProjectSub, "status" | "currentPeriodEnd" | "trialEnd">[]): Date | null {
  let latest: Date | null = null;
  for (const s of subs) {
    const end = paidUntil(s);
    if (end && (!latest || end > latest)) latest = end;
  }
  return latest;
}

async function saveProjectSnapshots(tx: TenantTx, subs: readonly StripeSubscription[]): Promise<void> {
  for (const s of subs) {
    const row = projectSubFromStripe(s);
    if (row) await saveProjectSubscription(tx, row, row.projectId);
  }
  await refreshStanding(tx);
}

// The workspace owner closes the workspace after typing its name. Stripe cancels the subscription
// at the end of its period first (in the per-project model, every project subscription); if that
// fails, nothing is closed and the owner can try again. The workspace works until that date; then
// members see the closed page.
export async function closeWorkspace(deps: CloseDeps, input: { user: UserId; tenant: TenantId; typedName: string }): Promise<CloseResult> {
  const { user, tenant } = input;
  const pre = await withTenantForUser(deps.pool, user, tenant, async (tx, role) => {
    if (role !== "owner") return { stop: "role" as const };
    if (await getClosure(tx)) return { stop: "already_closed" as const };
    if (!confirms(input.typedName, await workspaceName(tx))) return { stop: "mismatch" as const };
    const b = await getBilling(tx);
    if (b.model === "project") {
      const toCancel = (await listProjectSubscriptions(tx)).filter((s) => isLive(s.status) && !s.cancelAtPeriodEnd).map((s) => s.subscriptionId);
      return { stop: null, subscription: null, projectSubs: toCancel };
    }
    const live = b.subscriptionId && !ENDED.has(b.status) && !b.cancelAtPeriodEnd;
    return { stop: null, subscription: live ? b.subscriptionId : null, projectSubs: [] as string[] };
  });
  if (pre.stop) return pre.stop;

  let snapshot: SubscriptionSnapshot | null = null;
  if ("subscription" in pre && pre.subscription && deps.stripe) snapshot = await deps.stripe.setCancelAtPeriodEnd(pre.subscription, true);
  const projectSnapshots: StripeSubscription[] = [];
  if ("projectSubs" in pre && deps.stripe) {
    for (const id of pre.projectSubs) projectSnapshots.push(await deps.stripe.setCancelAtPeriodEnd(id, true));
  }

  return withTenantForUser(deps.pool, user, tenant, async (tx, role) => {
    if (role !== "owner") return "role";
    if (await getClosure(tx)) return "already_closed";
    // Save Stripe's answer now rather than wait for the webhook.
    if (snapshot) await saveSubscription(tx, snapshot, null);
    if (projectSnapshots.length > 0) await saveProjectSnapshots(tx, projectSnapshots);
    const now = deps.now();
    const b = await getBilling(tx);
    let until: Date | null;
    if (b.model === "project") {
      const subs = (await listProjectSubscriptions(tx)).filter((s) => isLive(s.status));
      const trial = b.trialEnd && b.trialEnd > now ? b.trialEnd : null;
      const paid = projectsPaidUntil(subs);
      until = paid && trial ? (paid > trial ? paid : trial) : paid ?? trial;
    } else {
      until = paidUntil(b);
    }
    await recordClosure(tx, user, now, (b.exempt ? null : until) ?? now);
    return "closed";
  });
}

export type ReopenOutcome = ReopenResult | "role";

// The owner reopens before the purge. A subscription whose cancel is still pending resumes; one
// that has ended means the billing page asks for a card, with no new trial.
export async function reopenClosedWorkspace(deps: CloseDeps, input: { user: UserId; tenant: TenantId }): Promise<ReopenOutcome> {
  const pre = await withTenantForUser(deps.pool, input.user, input.tenant, async (tx, role) => {
    if (role !== "owner") return { stop: "role" as const };
    const c = await getClosure(tx);
    if (!c) return { stop: "not_closed" as const };
    if (c.purgedAt) return { stop: "too_late" as const };
    const b = await getBilling(tx);
    if (b.model === "project") {
      // Resume the subscriptions of projects still watched; a removed or paused project's
      // subscription keeps running out its period.
      const watched = new Set((await watchedProjects(tx)).map((p) => p.id));
      const resume = (await listProjectSubscriptions(tx))
        .filter((s) => s.projectId && watched.has(s.projectId) && isLive(s.status) && s.cancelAtPeriodEnd)
        .map((s) => s.subscriptionId);
      return { stop: null, resume: null, projectSubs: resume };
    }
    return { stop: null, resume: b.subscriptionId && !ENDED.has(b.status) && b.cancelAtPeriodEnd ? b.subscriptionId : null, projectSubs: [] as string[] };
  });
  if (pre.stop) return pre.stop;
  let snapshot: SubscriptionSnapshot | null = null;
  if ("resume" in pre && pre.resume && deps.stripe) snapshot = await deps.stripe.setCancelAtPeriodEnd(pre.resume, false);
  const projectSnapshots: StripeSubscription[] = [];
  if ("projectSubs" in pre && deps.stripe) {
    for (const id of pre.projectSubs) projectSnapshots.push(await deps.stripe.setCancelAtPeriodEnd(id, false));
  }
  return withTenantForUser(deps.pool, input.user, input.tenant, async (tx, role) => {
    if (role !== "owner") return "role";
    if (snapshot) await saveSubscription(tx, snapshot, null);
    if (projectSnapshots.length > 0) await saveProjectSnapshots(tx, projectSnapshots);
    return reopenWorkspace(tx);
  });
}

export type DisconnectResult = "disconnected" | "role" | "mismatch" | "missing";

export interface DisconnectDeps {
  pool: Pool;
  vault: TokenVault;
  // Ends the grant at Supabase; best effort (supabase/oauth.ts revokeGrant). Null: skip.
  revoke: ((refreshToken: string) => Promise<boolean>) | null;
  now?: () => Date;
}

export interface DisconnectOutcome {
  result: DisconnectResult;
  // True when Supabase confirmed the grant is revoked. False: the owner must remove the app in
  // their Supabase organization (the page says so).
  revoked: boolean;
  projectsPaused: number;
  // For the notification email (sendDisconnectEmails); null unless disconnected.
  notice: DisconnectNotice | null;
}

export interface DisconnectNotice extends Disconnected {
  workspaceName: string;
  paying: boolean;
  at: Date;
}

// A workspace owner or admin disconnects a Supabase connection after typing its label. The sealed
// token is emptied at once and the connection's projects pause, so polling stops at once. The
// history stays for 30 days (longer while the workspace pays), then the data job deletes it. A
// connection with no project has nothing to keep and goes at once. RLS refuses the write for any
// other role.
export async function disconnectConnection(
  deps: DisconnectDeps,
  input: { user: UserId; tenant: TenantId; connection: ConnectionId; typedLabel: string },
): Promise<DisconnectOutcome> {
  const none = (result: DisconnectResult): DisconnectOutcome => ({ result, revoked: false, projectsPaused: 0, notice: null });
  const pre = await withTenantForUser(deps.pool, input.user, input.tenant, async (tx, role) => {
    if (role === "member") return { stop: "role" as const };
    const [conn] = await tx.query<{ label: string; sealed_token: Buffer }>(
      "SELECT label, sealed_token FROM supahound.connections WHERE tenant_id = $1 AND id = $2 AND disconnected_at IS NULL",
      [tx.tenantId, input.connection],
    );
    if (!conn) return { stop: "missing" as const };
    if (!confirms(input.typedLabel, conn.label)) return { stop: "mismatch" as const };
    let refreshToken: string | null = null;
    try {
      refreshToken = parseCredentials(deps.vault.open(conn.sealed_token, { tenantId: tx.tenantId, connectionId: input.connection })).refreshToken;
    } catch {
      // A token that no longer opens cannot be revoked; emptying it is still right.
    }
    return { stop: null, refreshToken };
  });
  if (pre.stop) return none(pre.stop);

  const revoked = "refreshToken" in pre && pre.refreshToken && deps.revoke ? await deps.revoke(pre.refreshToken).catch(() => false) : false;

  return withTenantForUser(deps.pool, input.user, input.tenant, async (tx, role) => {
    if (role === "member") return none("role");
    const now = deps.now?.() ?? new Date();
    const d = await markDisconnected(tx, input.connection, now, "user", input.user);
    if (!d) return none("missing");
    if (d.projects.length === 0) {
      await tx.query("DELETE FROM supahound.connections WHERE tenant_id = $1 AND id = $2", [tx.tenantId, input.connection]);
    }
    const notice = { ...d, workspaceName: await workspaceName(tx), paying: await isPaying(tx), at: now };
    return { result: "disconnected", revoked, projectsPaused: d.projects.length, notice };
  });
}

// The grant ended outside Supahound (the poller saw supabase/oauth.ts isRevokedGrant). Marks the
// connection, in the caller's transaction, exactly as an in-app disconnect would, with reason
// "revoked". Null when another worker already marked it: only the first sends the email.
export async function markRevoked(tx: TenantTx, connection: ConnectionId, now: Date): Promise<DisconnectNotice | null> {
  const d = await markDisconnected(tx, connection, now, "revoked", null);
  if (!d) return null;
  return { ...d, workspaceName: await workspaceName(tx), paying: await isPaying(tx), at: now };
}

export interface NoticeMailer {
  send: (message: { to: string; from: { email: string; name: string }; subject: string; text: string; html: string }) => Promise<unknown>;
  from: { email: string; name: string };
  appUrl: string;
}

// One email per recipient, after the disconnect committed. Counts go to the audit log; a failed
// send is not retried (decision 037). Never throws.
export async function sendDisconnectEmails(
  pool: Pool,
  tenant: TenantId,
  notice: DisconnectNotice,
  kind: "user" | "revoked",
  actorEmail: string | null,
  mailer: NoticeMailer,
): Promise<{ sent: number; failed: number }> {
  const rendered = renderDisconnectEmail({
    kind, workspaceName: notice.workspaceName, label: notice.label, actorEmail, at: notice.at, projects: notice.projects,
    paying: notice.paying, deleteAfter: notice.deleteAfter, settingsUrl: new URL(`/w/${tenant}/settings`, mailer.appUrl).toString(),
  });
  let sent = 0;
  let failed = 0;
  for (const to of notice.recipients) {
    try {
      await mailer.send({ to, from: mailer.from, ...rendered });
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  try {
    await withTenant(pool, tenant, (tx) => appendAudit(tx, {
      projectId: null, action: "alert_email",
      detail: { kind: kind === "user" ? "disconnected" : "access_revoked", connection_id: notice.connection, recipients: notice.recipients.length, sent, failed },
    }));
  } catch {
    // The emails went out; a lost audit row must not fail the caller.
  }
  return { sent, failed };
}

export interface DataJobOutcome {
  paying: boolean;
  purged: boolean;
  retention: RetentionResult | null;
  connectionsDeleted: number;
}

// The daily data job for one tenant (decision 037), in one tenant transaction. It asks once, at
// the start, whether the workspace pays; while it does, nothing is deleted and every pending
// delete moves to 30 days after today.
export async function runDataJob(pool: Pool, tenant: TenantId, now: Date): Promise<DataJobOutcome> {
  return withTenant(pool, tenant, async (tx) => {
    const paying = await isPaying(tx);
    const closure = await getClosure(tx);
    if (closure?.purgedAt) return { paying, purged: false, retention: null, connectionsDeleted: 0 };
    // purgeHistory checks purge_after itself, in the UPDATE that claims the purge.
    if (closure && paying) await deferPurge(tx, now);
    else if (closure && (await purgeHistory(tx, now))) {
      return { paying, purged: true, retention: null, connectionsDeleted: 0 };
    }
    let connectionsDeleted = 0;
    if (paying) await deferConnectionDeletes(tx, now);
    else connectionsDeleted = await deleteExpiredConnections(tx, now);
    const retention = await applyRetention(tx, now, { deleteHistory: !paying });
    return { paying, purged: false, retention, connectionsDeleted };
  });
}
