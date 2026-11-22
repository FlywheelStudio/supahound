import type { SecurityEventCursor, SecurityEventItem } from "@supahound/core/db/securityEvents";
import type { Role } from "@supahound/core/db/user";
import type { TenantId } from "@supahound/core/tenancy/scope";
import { parseCursor as parseIncidentCursor } from "./incidents";
import { ROLE_LABEL } from "./people";
import { isProjectRole } from "@supahound/core/db/people";

// Workspace settings → Security log (issue #138, decision 044). Pure helpers: the URL cursor, who
// may read it, and one line of text per event. The event rows hold IDs and enums only; the page
// shows a person's address while they are still in the workspace.

export const SECURITY_LOG_PAGE_SIZE = 50;

export const securityLogPath = (tenant: TenantId): string => `/w/${tenant}/settings/security`;

// Workspace owners only. RLS (owner_read) returns no rows to anyone else, whatever the page does.
export const canReadSecurityLog = (role: Role): boolean => role === "owner";

// "<epoch microseconds>_<event id>", the same shape as the incident history cursor.
export function encodeSecurityCursor(c: SecurityEventCursor): string {
  return `${c.createdUs}_${c.id}`;
}

export function parseSecurityCursor(raw: string | string[] | undefined): SecurityEventCursor | null | "invalid" {
  const c = parseIncidentCursor(raw);
  return c === null || c === "invalid" ? c : { createdUs: c.lastSeenUs, id: c.id };
}

const roleLabel = (v: unknown): string => (isProjectRole(v) ? ROLE_LABEL[v] : "a role");

// Who did it: their address, "Supahound" for the system, or a short ID for someone who has left.
export function actorLabel(e: Pick<SecurityEventItem, "actorId" | "actorEmail">): string {
  if (e.actorId === null) return "Supahound";
  return e.actorEmail ?? `Former member ${e.actorId.slice(0, 8)}`;
}

function targetLabel(e: Pick<SecurityEventItem, "targetId" | "targetEmail">): string {
  if (e.targetEmail) return e.targetEmail;
  return e.targetId ? `person ${e.targetId.slice(0, 8)}` : "a person";
}

const onProject = (e: Pick<SecurityEventItem, "projectName">) => (e.projectName ? ` on ${e.projectName}` : "");

// What happened, in one sentence without the actor.
export function describeEvent(e: SecurityEventItem): string {
  const d = e.detail;
  switch (e.action) {
    case "sign_in":
      return "Signed in";
    case "invite_sent":
      return `${d.kind === "resent" ? "Resent" : "Sent"} an invite as ${roleLabel(d.role)}${onProject(e)}`;
    case "invite_accepted":
      return `Accepted an invite as ${roleLabel(d.role)}${onProject(e)}`;
    case "invite_revoked":
      return `Canceled an invite for ${roleLabel(d.role)}${onProject(e)}`;
    case "role_changed":
      return `Changed the role of ${targetLabel(e)}${onProject(e)} from ${roleLabel(d.from)} to ${roleLabel(d.role)}`;
    case "member_removed":
      return `Removed ${targetLabel(e)} (${roleLabel(d.role)}) from ${e.projectName ?? "a project"}`;
    case "connection_added":
      return d.reattached === true ? "Reconnected a Supabase organization" : "Connected a Supabase organization";
    case "connection_removed":
      return d.reason === "revoked" ? "Supabase access was revoked outside Supahound" : "Disconnected a Supabase organization";
    case "project_added":
      return `Added the project ${e.projectName ?? "(since deleted)"}`;
    case "project_removed":
      return `Removed the project ${e.projectName ?? "(since deleted)"}`;
    case "project_kept":
      return `Kept the project ${e.projectName ?? "(since deleted)"}`;
    case "workspace_closed":
      return "Closed the workspace";
    case "workspace_reopened":
      return "Kept the workspace open";
    case "data_deleted": {
      const n = typeof d.count === "number" ? d.count : 0;
      if (d.kind === "removed_projects") return `Deleted ${n} removed project${n === 1 ? "" : "s"} and their history`;
      if (d.kind === "disconnected_connections") return `Deleted the history of ${n} disconnected Supabase organization${n === 1 ? "" : "s"}`;
      return "Deleted data";
    }
  }
}

const REASONS: Record<string, string> = {
  role: "their role does not allow it",
  expired: "the invite had expired",
  used: "the invite was already used",
  canceled: "the invite was canceled",
  wrong_email: "signed in with a different address",
  email: "the email did not send",
};

// The outcome, for the Result column.
export function resultLabel(e: Pick<SecurityEventItem, "result" | "detail">): string {
  const why = typeof e.detail.reason === "string" ? REASONS[e.detail.reason] : undefined;
  if (e.result === "success") return "Done";
  const head = e.result === "denied" ? "Refused" : "Failed";
  return why ? `${head}: ${why}` : head;
}
