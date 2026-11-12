import { isStorableEmail } from "@supahound/core/db/repo";
import { isProjectRole, type Person, type ProjectRole } from "@supahound/core/db/people";
import type { Role } from "@supahound/core/db/user";
import type { ProjectId, TenantId } from "@supahound/core/tenancy/scope";
import { projectPath } from "./nav";

// People and roles per project (issue #24, decision 036) as pure functions, so every rule is
// testable. The server actions call these inside the same transaction as the write; RLS refuses
// the same writes again in the database (migration 20261112000000_project_people.sql).

export const ROLE_LABEL: Record<ProjectRole, string> = { owner: "Owner", admin: "Admin", editor: "Editor", viewer: "Viewer" };

export const ROLE_HELP: Record<ProjectRole, string> = {
  owner: "Everything, including people with the Owner role and removing the project.",
  admin: "Invites and manages people (not Owners) and changes settings.",
  editor: "Changes the project's settings, such as email alerts.",
  viewer: "Sees the project's dashboard, incidents and settings. Changes nothing.",
};

// The role matrix (decision 036). Workspace-level actions (connect Supabase, add projects,
// billing) keep the workspace role and are not here.
export type ProjectAction = "view" | "edit_settings" | "manage_people" | "manage_owners";

const MATRIX: Record<ProjectAction, readonly ProjectRole[]> = {
  view: ["owner", "admin", "editor", "viewer"],
  edit_settings: ["owner", "admin", "editor"],
  manage_people: ["owner", "admin"],
  manage_owners: ["owner"],
};

export function can(role: ProjectRole | null, action: ProjectAction): boolean {
  return role !== null && MATRIX[action].includes(role);
}

// Removing a project: its Owner, or a workspace owner or admin (who could remove it before
// per-project roles existed, and who can add projects).
export function canRemoveProject(role: ProjectRole | null, workspaceRole: Role): boolean {
  return role === "owner" || workspaceRole === "owner" || workspaceRole === "admin";
}

// The roles this person may grant: an Owner any role, an Admin any role but Owner.
export function assignableRoles(actor: ProjectRole | null): ProjectRole[] {
  if (can(actor, "manage_owners")) return ["owner", "admin", "editor", "viewer"];
  if (can(actor, "manage_people")) return ["admin", "editor", "viewer"];
  return [];
}

export function canGrant(actor: ProjectRole | null, role: ProjectRole): boolean {
  return assignableRoles(actor).includes(role);
}

// Whether the actor may change or remove this person on the project. Never themselves (no
// accidental lock-out), never a workspace owner or admin (their role follows from the workspace),
// and only an Owner touches an Owner.
export function canManagePerson(actor: ProjectRole | null, actorId: string, target: Pick<Person, "userId" | "role" | "source">): boolean {
  if (!can(actor, "manage_people") || target.userId === actorId || target.source !== "project") return false;
  return target.role !== "owner" || can(actor, "manage_owners");
}

// An invite or invite action on an existing invite: the actor needs to be able to grant its role.
export function canInviteAs(actor: ProjectRole | null, role: ProjectRole): boolean {
  return canGrant(actor, role);
}

export function parseInviteEmail(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const email = value.trim().toLowerCase();
  return isStorableEmail(email) && /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email) ? email : null;
}

export function parseRole(value: unknown): ProjectRole | null {
  return isProjectRole(value) ? value : null;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;
export function parseUuid(value: unknown): string | null {
  return typeof value === "string" && UUID.test(value.toLowerCase()) ? value.toLowerCase() : null;
}

export function inviteUrl(appUrl: string, token: string): string {
  const url = new URL("/invite", appUrl);
  url.searchParams.set("token", token);
  return url.toString();
}

// The invite page, optionally with an accept outcome to show.
export function invitePagePath(token: string, error?: keyof typeof ACCEPT_ERRORS): string {
  const q = new URLSearchParams({ token });
  if (error) q.set("error", error);
  return `/invite?${q.toString()}`;
}

export type PeopleNotice =
  | "invited" | "renewed" | "resent" | "canceled" | "role_saved" | "removed"
  | "role" | "email" | "member" | "cooldown" | "missing" | "send_failed";

export const PEOPLE_NOTICES: Record<PeopleNotice, { tone: "ok" | "error"; text: string }> = {
  invited: { tone: "ok", text: "Invite sent. It expires in 7 days." },
  renewed: { tone: "ok", text: "That address already had an invite. We sent a new one; the old link no longer works." },
  resent: { tone: "ok", text: "Invite sent again. The old link no longer works, and the new one expires in 7 days." },
  canceled: { tone: "ok", text: "Invite canceled. Its link no longer works." },
  role_saved: { tone: "ok", text: "Role saved." },
  removed: { tone: "ok", text: "Removed from this project." },
  role: { tone: "error", text: "Your role on this project does not allow that." },
  email: { tone: "error", text: "Enter a valid email address." },
  member: { tone: "error", text: "That person already has a role on this project." },
  cooldown: { tone: "error", text: "That invite was sent less than a minute ago. Wait, then try again." },
  missing: { tone: "error", text: "That person or invite is no longer on this project." },
  send_failed: { tone: "error", text: "The invite is saved, but the email did not send. Use Resend to try again." },
};

export function peoplePath(tenant: TenantId, project: ProjectId, notice?: PeopleNotice): string {
  const base = projectPath(tenant, project, "people");
  return notice ? `${base}?${PEOPLE_NOTICES[notice].tone === "ok" ? "done" : "error"}=${notice}` : base;
}

export function noticeFrom(query: Record<string, string | undefined>): { tone: "ok" | "error"; text: string } | null {
  const key = query.done ?? query.error;
  return key && key in PEOPLE_NOTICES ? PEOPLE_NOTICES[key as PeopleNotice] : null;
}

// --- Invite flow -------------------------------------------------------------------------------------

export interface InviteDeps {
  // A new secret token (core newInviteToken).
  token: () => string;
  // In one paid, project-scoped transaction: the actor's role; and, only if the actor may grant
  // `role`, the stored invite (core createInvite with the token's hash). Must not write otherwise.
  save: (email: string, role: ProjectRole, token: string) => Promise<{ actor: ProjectRole | null; result: "created" | "renewed" | "member" | "invalid" | null }>;
  // After the transaction commits: the email with the accept link.
  send: (email: string, token: string) => Promise<void>;
}

export async function handleInvite(
  tenant: TenantId,
  project: ProjectId,
  rawEmail: unknown,
  rawRole: unknown,
  deps: InviteDeps,
): Promise<string> {
  const email = parseInviteEmail(rawEmail);
  const role = parseRole(rawRole);
  if (!email) return peoplePath(tenant, project, "email");
  if (!role) return peoplePath(tenant, project, "role");
  const token = deps.token();
  const { actor, result } = await deps.save(email, role, token);
  if (!canInviteAs(actor, role) || result === null) return peoplePath(tenant, project, "role");
  if (result === "member") return peoplePath(tenant, project, "member");
  if (result === "invalid") return peoplePath(tenant, project, "email");
  try {
    await deps.send(email, token);
  } catch {
    return peoplePath(tenant, project, "send_failed");
  }
  return peoplePath(tenant, project, result === "renewed" ? "renewed" : "invited");
}

// The accept page's message for each outcome of core acceptInvite / previewInvite.
export const ACCEPT_ERRORS: Record<"invalid" | "expired" | "used" | "canceled" | "wrong_email", string> = {
  invalid: "This invite link is not valid. Ask for a new invite.",
  expired: "This invite has expired. Ask an owner or admin of the project to resend it.",
  used: "This invite was already used. Each invite works once.",
  canceled: "This invite was canceled. Ask an owner or admin of the project for a new one.",
  wrong_email: "This invite is for a different email address. Sign out, then sign in with the invited address.",
};
