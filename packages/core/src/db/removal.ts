import { currentSubFor, isLive, removalDates, type ProjectSub, type RemovalDates } from "../billing/projects.js";
import type { ProjectId } from "../tenancy/scope.js";
import { getBilling, listProjectSubscriptions } from "./billing.js";
import { getClosure } from "./closure.js";
import type { TenantTx } from "./tenant.js";

// Project removal with a grace period (decision 042). Removing a project schedules its deletion:
// it stays active until its subscription's period ends (active_until), then the poller stops, and
// the daily data job deletes it 7 days later (delete_after) unless an Owner or Admin keeps it.
// Every function runs inside a tenant transaction. Who may schedule or undo: a workspace owner or
// admin, or the project's Owner (decision 036). The WHERE clause checks it, so the functions return
// false for anyone else; the migration's trigger refuses a raw UPDATE from them too.

const MAY_REMOVE = `((SELECT supahound.current_user_id()) IS NULL
  OR (SELECT supahound.current_workspace_role()) IN ('owner', 'admin')
  OR supahound.project_role(id) = 'owner')`;

export interface RemovalSchedule {
  requestedAt: Date;
  activeUntil: Date;
  deleteAfter: Date;
  source: "user" | "billing";
}

// The dates a removal made now would get: the project's current subscription decides
// (billing/projects.ts removalActiveUntil). An exempt or seat workspace, or no subscription row:
// the project stops now and is deleted 7 days later.
export async function removalPreview(tx: TenantTx, id: ProjectId, now: Date): Promise<RemovalDates> {
  const billing = await getBilling(tx);
  const sub = billing.model === "project" && !billing.exempt ? currentSubFor(id, await listProjectSubscriptions(tx)) : null;
  return removalDates(sub, now);
}

// Schedules the removal. Null when the project is not here, is already scheduled, or the user may
// not remove it. The caller confirms the typed name first.
export async function scheduleRemoval(
  tx: TenantTx,
  id: ProjectId,
  now: Date,
  opts: { source?: "user" | "billing"; dates?: RemovalDates } = {},
): Promise<RemovalSchedule | null> {
  const dates = opts.dates ?? (await removalPreview(tx, id, now));
  const source = opts.source ?? "user";
  const rows = await tx.query(
    `UPDATE supahound.projects
     SET removal_requested_at = $3, active_until = $4, delete_after = $5, removal_source = $6
     WHERE tenant_id = $1 AND id = $2 AND removal_requested_at IS NULL AND ${MAY_REMOVE}
     RETURNING id`,
    [tx.tenantId, id, now, dates.activeUntil, dates.deleteAfter, source],
  );
  return rows.length === 1 ? { requestedAt: now, ...dates, source } : null;
}

// "Keep project": clears the removal. False when there is nothing to undo or the user may not.
// It does not touch the subscription or the standing: the caller reconciles after the commit,
// which resumes the subscription or, after the period, creates a new one (decision 042).
export async function cancelRemoval(tx: TenantTx, id: ProjectId): Promise<boolean> {
  const rows = await tx.query(
    `UPDATE supahound.projects
     SET removal_requested_at = NULL, active_until = NULL, delete_after = NULL, removal_source = NULL
     WHERE tenant_id = $1 AND id = $2 AND removal_requested_at IS NOT NULL AND ${MAY_REMOVE}
     RETURNING id`,
    [tx.tenantId, id],
  );
  return rows.length === 1;
}

export async function getRemoval(tx: TenantTx, id: ProjectId): Promise<RemovalSchedule | null> {
  const [r] = await tx.query<{ removal_requested_at: Date | null; active_until: Date; delete_after: Date; removal_source: "user" | "billing" }>(
    "SELECT removal_requested_at, active_until, delete_after, removal_source FROM supahound.projects WHERE tenant_id = $1 AND id = $2",
    [tx.tenantId, id],
  );
  if (!r?.removal_requested_at) return null;
  return { requestedAt: r.removal_requested_at, activeUntil: r.active_until, deleteAfter: r.delete_after, source: r.removal_source };
}

// Deletes a project and, by cascade, its incidents, findings, poll runs, service-key networks,
// usage, people, invites and posture scans. Audit rows and subscription rows stay, with project_id
// set to NULL (decisions 022 and 041). Only the data job (deleteRemovedProjects) and tests call it.
export async function deleteProject(tx: TenantTx, id: ProjectId): Promise<boolean> {
  const rows = await tx.query("DELETE FROM supahound.projects WHERE tenant_id = $1 AND id = $2 RETURNING id", [tx.tenantId, id]);
  return rows.length === 1;
}

// The data job (decision 042): deletes every scheduled project whose delete_after has come. The
// condition sits in the DELETE itself, so an undo that commits first always wins. Runs whether or
// not the workspace pays: the removed project's own payment has ended (overrides 037 point 1 for
// removed projects only).
export async function deleteRemovedProjects(tx: TenantTx, now: Date): Promise<number> {
  const rows = await tx.query(
    `DELETE FROM supahound.projects
     WHERE tenant_id = $1 AND removal_requested_at IS NOT NULL AND delete_after <= $2
     RETURNING id`,
    [tx.tenantId, now],
  );
  return rows.length;
}

// The Stripe webhook saw a project subscription (decision 042). Only a change of the cancel flag
// counts, compared with the row stored before this event:
// - false → true: a cancel from the Billing Portal. The project is scheduled for removal with the
//   subscription's period end, unless it is already scheduled (a removal in Supahound cancels the
//   subscription too), paused (a disconnect cancels through reconcile) or the workspace is closing
//   (closing cancels every subscription; datacontrols/flow.ts undoes a removal that raced the close).
// - true → false: a resume. A scheduled removal is cleared, whoever scheduled it: Stripe's state wins.
// No change (an invoice event, our own save that came first): nothing. So a resume that failed
// after an undo is not turned back into a removal by the next unrelated event.
export async function applyPortalCancel(
  tx: TenantTx,
  sub: Pick<ProjectSub, "subscriptionId" | "status" | "trialEnd" | "currentPeriodEnd" | "cancelAtPeriodEnd">,
  wasCanceling: boolean,
  now: Date,
): Promise<"scheduled" | "cleared" | null> {
  if (wasCanceling === sub.cancelAtPeriodEnd) return null;
  const [row] = await tx.query<{ id: ProjectId; paused: boolean; scheduled: boolean }>(
    `SELECT p.id, p.paused, p.removal_requested_at IS NOT NULL AS scheduled
     FROM supahound.project_subscriptions s JOIN supahound.projects p ON p.tenant_id = s.tenant_id AND p.id = s.project_id
     WHERE s.tenant_id = $1 AND s.subscription_id = $2`,
    [tx.tenantId, sub.subscriptionId],
  );
  if (!row) return null;
  if (sub.cancelAtPeriodEnd) {
    if (row.scheduled || row.paused || !isLive(sub.status) || (await getClosure(tx))) return null;
    return (await scheduleRemoval(tx, row.id, now, { source: "billing", dates: removalDates(sub, now) })) ? "scheduled" : null;
  }
  if (!row.scheduled) return null;
  return (await cancelRemoval(tx, row.id)) ? "cleared" : null;
}
