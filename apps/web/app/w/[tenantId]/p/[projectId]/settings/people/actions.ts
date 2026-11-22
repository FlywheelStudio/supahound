"use server";

import {
  cancelInvite, createInvite, getOpenInvite, INVITE_TTL_DAYS, inviteTokenHash, listPeople, newInviteToken, openInviteFor, removePerson,
  renewInvite, setPersonRole, type ProjectRole,
} from "@supahound/core/db/people";
import { getProject } from "@supahound/core/db/repo";
import { recordSecurityEvent } from "@supahound/core/db/securityEvents";
import type { ProjectId, TenantId, UserId } from "@supahound/core/tenancy/scope";
import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";
import { withPool } from "../../../../../../../lib/db";
import { renderInviteEmail } from "../../../../../../../lib/email/invite";
import {
  canGrant, canInviteAs, canManagePerson, handleInvite, inviteUrl, parseRole, parseUuid, peoplePath, type PeopleNotice,
} from "../../../../../../../lib/people";
import { paidProject, parseIds, projectActionError } from "../../../../../../../lib/projectPage";
import { requireUser } from "../../../../../../../lib/supabase";

// Project settings → People (issue #24, decision 036). Every action checks the actor's role on
// this project inside the same transaction as the write (lib/people.ts holds the rules), and RLS
// refuses the same writes again. Emails go out only after the transaction commits. Each outcome
// that changes access, and each refusal by role, is a security event in the same transaction
// (decision 044).

function ids(formData: FormData): { tenant: TenantId; project: ProjectId } {
  return parseIds(String(formData.get("tenantId") ?? ""), String(formData.get("projectId") ?? ""));
}

async function sendInvite(input: { email: string; token: string; projectName: string; role: ProjectRole; inviter: string | null }): Promise<void> {
  const rendered = renderInviteEmail({
    projectName: input.projectName, role: input.role, inviterEmail: input.inviter,
    link: inviteUrl(env.APP_URL, input.token), expiresInDays: INVITE_TTL_DAYS,
  });
  await env.EMAIL.send({ to: input.email, from: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME }, ...rendered });
}

// The invite is saved but its email did not go: a failed invite_sent, in its own transaction.
// Best effort; the page already says to resend.
async function emailFailed(pool: Parameters<typeof paidProject>[0], user: UserId, tenant: TenantId, project: ProjectId, invite: string | null, role: ProjectRole) {
  await paidProject(pool, user, tenant, project, (tx) =>
    recordSecurityEvent(tx, { action: "invite_sent", result: "failed", actor: user, project, target: invite, detail: { role, reason: "email" } }),
  ).catch(() => undefined);
}

export async function inviteAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project } = ids(formData);
  let projectName = "";
  let invitedRole: ProjectRole = "viewer";
  let inviteId: string | null = null;
  const path = await withPool((pool) =>
    handleInvite(tenant, project, formData.get("email"), formData.get("role"), {
      token: () => newInviteToken(tenant),
      save: (email, role, token) =>
        paidProject(pool, user.id, tenant, project, async (tx, actor) => {
          const denied = async () => {
            await recordSecurityEvent(tx, { action: "invite_sent", result: "denied", actor: user.id, project, detail: { role, reason: "role" } });
            return { actor, result: null };
          };
          if (!canInviteAs(actor, role)) return denied();
          const pending = await openInviteFor(tx, project, email);
          if (pending && !canInviteAs(actor, pending.role)) return denied();
          projectName = (await getProject(tx, project))?.name ?? "";
          invitedRole = role;
          const result = await createInvite(tx, { project, email, role, invitedBy: user.id, tokenHash: inviteTokenHash(token), now: new Date() });
          if (result === "created" || result === "renewed") {
            inviteId = (await openInviteFor(tx, project, email))?.id ?? null;
            await recordSecurityEvent(tx, { action: "invite_sent", actor: user.id, project, target: inviteId, detail: { role, kind: result } });
          }
          return { actor, result };
        }),
      send: async (email, token) => {
        try {
          await sendInvite({ email, token, projectName, role: invitedRole, inviter: user.email });
        } catch (err) {
          await emailFailed(pool, user.id, tenant, project, inviteId, invitedRole);
          throw err;
        }
      },
    }),
  ).catch(projectActionError);
  redirect(path);
}

export async function resendInviteAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project } = ids(formData);
  const inviteId = parseUuid(formData.get("inviteId"));
  const token = newInviteToken(tenant);
  const notice: PeopleNotice = await withPool(async (pool) => {
    if (!inviteId) return "missing" as const;
    const out = await paidProject(pool, user.id, tenant, project, async (tx, actor) => {
      const invite = await getOpenInvite(tx, project, inviteId);
      if (!invite) return "missing" as const;
      if (!canInviteAs(actor, invite.role)) {
        await recordSecurityEvent(tx, { action: "invite_sent", result: "denied", actor: user.id, project, target: inviteId, detail: { role: invite.role, kind: "resent", reason: "role" } });
        return "role" as const;
      }
      const renewed = await renewInvite(tx, { project, inviteId, tokenHash: inviteTokenHash(token), now: new Date() });
      if (renewed === null) return "missing" as const;
      if (renewed === "cooldown") return "cooldown" as const;
      await recordSecurityEvent(tx, { action: "invite_sent", actor: user.id, project, target: inviteId, detail: { role: renewed.role, kind: "resent" } });
      return { ...renewed, projectName: (await getProject(tx, project))?.name ?? "" };
    });
    if (typeof out === "string") return out;
    try {
      await sendInvite({ email: out.email, token, projectName: out.projectName, role: out.role, inviter: user.email });
    } catch {
      await emailFailed(pool, user.id, tenant, project, inviteId, out.role);
      return "send_failed" as const;
    }
    return "resent" as const;
  }).catch(projectActionError);
  redirect(peoplePath(tenant, project, notice));
}

export async function cancelInviteAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project } = ids(formData);
  const inviteId = parseUuid(formData.get("inviteId"));
  const notice: PeopleNotice = await withPool(async (pool) => {
    if (!inviteId) return "missing" as const;
    return paidProject(pool, user.id, tenant, project, async (tx, actor) => {
      const invite = await getOpenInvite(tx, project, inviteId);
      if (!invite) return "missing" as const;
      const event = { action: "invite_revoked", actor: user.id, project, target: inviteId, detail: { role: invite.role } } as const;
      if (!canInviteAs(actor, invite.role)) {
        await recordSecurityEvent(tx, { ...event, result: "denied", detail: { ...event.detail, reason: "role" } });
        return "role" as const;
      }
      if (!(await cancelInvite(tx, project, inviteId, new Date()))) return "missing" as const;
      await recordSecurityEvent(tx, event);
      return "canceled" as const;
    });
  }).catch(projectActionError);
  redirect(peoplePath(tenant, project, notice));
}

export async function setRoleAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project } = ids(formData);
  const target = parseUuid(formData.get("userId"));
  const role = parseRole(formData.get("role"));
  const notice: PeopleNotice = await withPool(async (pool) => {
    if (!target || !role) return "missing" as const;
    return paidProject(pool, user.id, tenant, project, async (tx, actor) => {
      const person = (await listPeople(tx, project)).find((p) => p.userId === target);
      if (!person) return "missing" as const;
      const event = { action: "role_changed", actor: user.id, project, target, detail: { role, from: person.role } } as const;
      if (!canManagePerson(actor, user.id, person) || !canGrant(actor, role)) {
        await recordSecurityEvent(tx, { ...event, result: "denied", detail: { ...event.detail, reason: "role" } });
        return "role" as const;
      }
      if (!(await setPersonRole(tx, project, target, role))) return "missing" as const;
      await recordSecurityEvent(tx, event);
      return "role_saved" as const;
    });
  }).catch(projectActionError);
  redirect(peoplePath(tenant, project, notice));
}

export async function removePersonAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project } = ids(formData);
  const target = parseUuid(formData.get("userId"));
  const notice: PeopleNotice = await withPool(async (pool) => {
    if (!target) return "missing" as const;
    return paidProject(pool, user.id, tenant, project, async (tx, actor) => {
      const person = (await listPeople(tx, project)).find((p) => p.userId === target);
      if (!person) return "missing" as const;
      const event = { action: "member_removed", actor: user.id, project, target, detail: { role: person.role } } as const;
      if (!canManagePerson(actor, user.id, person)) {
        await recordSecurityEvent(tx, { ...event, result: "denied", detail: { ...event.detail, reason: "role" } });
        return "role" as const;
      }
      if (!(await removePerson(tx, project, target))) return "missing" as const;
      await recordSecurityEvent(tx, event);
      return "removed" as const;
    });
  }).catch(projectActionError);
  redirect(peoplePath(tenant, project, notice));
}
