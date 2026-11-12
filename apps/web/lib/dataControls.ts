import type { Closure } from "@supahound/core/db/closure";
import type { Role } from "@supahound/core/db/user";
import type { CloseResult, DisconnectOutcome, ReopenOutcome } from "@supahound/core/datacontrols/flow";
import type { TenantId } from "@supahound/core/tenancy/scope";

// Data controls in the web app (issue #43, decision 037) as pure functions, so every branch is
// testable without a browser. The server actions check roles again inside the transaction, and
// RLS refuses the same writes in the database.

// Disconnect: workspace owners and admins (the people who connect Supabase).
export const canDisconnect = (role: Role): boolean => role === "owner" || role === "admin";
// Close and reopen: workspace owners only.
export const canClose = (role: Role): boolean => role === "owner";

export const settingsPath = (tenant: TenantId) => `/w/${tenant}/settings`;
export const closedPath = (tenant: TenantId) => `/w/${tenant}/closed`;

// Where a data-controls form returns to. Only these two pages; anything else is the settings page.
export type Back = "settings" | "closed";
export const parseBack = (v: unknown): Back => (v === "closed" ? "closed" : "settings");
export const backPath = (tenant: TenantId, back: Back) => (back === "closed" ? closedPath(tenant) : settingsPath(tenant));

export function closeRedirect(tenant: TenantId, result: CloseResult | "failed"): string {
  switch (result) {
    // The settings page sends a workspace whose period has already ended on to its closed page.
    case "closed":
    case "already_closed":
      return `${settingsPath(tenant)}?closing=1`;
    case "mismatch":
      return `${settingsPath(tenant)}?error=close_mismatch`;
    case "role":
      return `${settingsPath(tenant)}?error=close_role`;
    case "failed":
      return `${settingsPath(tenant)}?error=close_failed`;
  }
}

export function reopenRedirect(tenant: TenantId, result: ReopenOutcome): string {
  switch (result) {
    case "reopened":
    case "not_closed":
      return `/w/${tenant}`;
    case "role":
      return `${closedPath(tenant)}?error=reopen_role`;
    case "too_late":
      return `${closedPath(tenant)}?error=reopen_late`;
  }
}

export function disconnectRedirect(tenant: TenantId, back: Back, connection: string, out: Pick<DisconnectOutcome, "result" | "revoked" | "projectsPaused">): string {
  const base = backPath(tenant, back);
  switch (out.result) {
    case "disconnected":
      return `${base}?disconnected=${out.revoked ? "revoked" : "local"}&removed=${out.projectsPaused}`;
    case "mismatch":
      return `${base}?disconnect=${encodeURIComponent(connection)}&error=disconnect_mismatch`;
    case "role":
      return `${base}?error=disconnect_role`;
    case "missing":
      return `${base}?error=disconnect_missing`;
  }
}

export const MESSAGES: Record<string, string> = {
  close_mismatch: "The name did not match. The workspace is still open.",
  close_role: "Only a workspace owner can close the workspace.",
  close_failed: "The workspace could not be closed, so nothing changed. Try again in a minute.",
  reopen_role: "Only a workspace owner can reopen the workspace.",
  reopen_late: "This workspace can no longer be reopened.",
  disconnect_mismatch: "The name did not match. Nothing was disconnected.",
  disconnect_role: "Only workspace owners and admins can disconnect Supabase.",
  disconnect_missing: "That Supabase connection is not in this workspace.",
};

export function disconnectedNotice(kind: string | undefined, removed: string | undefined): string | null {
  if (kind !== "revoked" && kind !== "local") return null;
  const n = Number(removed ?? 0);
  const projects = Number.isInteger(n) && n > 0
    ? ` and stopped watching ${n} project${n === 1 ? "" : "s"}. Everyone on ${n === 1 ? "it" : "them"} got an email`
    : "";
  const head = `Supabase disconnected. Supahound deleted its access token${projects}.`;
  return kind === "revoked"
    ? `${head} Supabase confirmed that the grant is revoked.`
    : `${head} Supabase did not confirm the revocation: remove the Supahound app in your Supabase organization's OAuth Apps settings.`;
}

export const ymd = (d: Date) => d.toISOString().slice(0, 10);

// The state of a connection, for the settings list (decision 037).
export function connectionState(
  c: { disconnectedAt: Date | null; disconnectReason: "user" | "revoked" | null; deleteAfter: Date | null },
  paying: boolean,
): string | null {
  if (!c.disconnectedAt) return null;
  const how = c.disconnectReason === "revoked" ? "Access revoked in Supabase" : "Disconnected";
  const keep = paying
    ? "History kept while the workspace pays."
    : `History deleted on ${ymd(c.deleteAfter ?? c.disconnectedAt)} unless you reconnect the same Supabase organization.`;
  return `${how} on ${ymd(c.disconnectedAt)}. ${keep}`;
}

// Whole days until the purge, rounded up; 0 on the day itself or after.
export function daysLeft(closure: Pick<Closure, "purgeAfter">, now: Date): number {
  return Math.max(0, Math.ceil((closure.purgeAfter.getTime() - now.getTime()) / 86_400_000));
}
