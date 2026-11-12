"use server";

import {
  cancelInvite, createInvite, getOpenInvite, INVITE_TTL_DAYS, inviteTokenHash, listPeople, newInviteToken, removePerson,
  renewInvite, setPersonRole, type ProjectRole,
} from "@supahound/core/db/people";
import { getProject } from "@supahound/core/db/repo";
import type { ProjectId, TenantId } from "@supahound/core/tenancy/scope";
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
// refuses the same writes again. Emails go out only after the transaction commits.

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

export async function inviteAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project } = ids(formData);
  let projectName = "";
  let invitedRole: ProjectRole = "viewer";
  const path = await withPool((pool) =>
    handleInvite(tenant, project, formData.get("email"), formData.get("role"), {
      token: () => newInviteToken(tenant),
      save: (email, role, token) =>
        paidProject(pool, user.id, tenant, project, async (tx, actor) => {
          if (!canInviteAs(actor, role)) return { actor, result: null };
          projectName = (await getProject(tx, project))?.name ?? "";
          invitedRole = role;
          const result = await createInvite(tx, { project, email, role, invitedBy: user.id, tokenHash: inviteTokenHash(token), now: new Date() });
          return { actor, result };
        }),
      send: (email, token) => sendInvite({ email, token, projectName, role: invitedRole, inviter: user.email }),
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
      if (!canInviteAs(actor, invite.role)) return "role" as const;
      const renewed = await renewInvite(tx, { project, inviteId, tokenHash: inviteTokenHash(token), now: new Date() });
      if (renewed === null) return "missing" as const;
      if (renewed === "cooldown") return "cooldown" as const;
      return { ...renewed, projectName: (await getProject(tx, project))?.name ?? "" };
    });
    if (typeof out === "string") return out;
    try {
      await sendInvite({ email: out.email, token, projectName: out.projectName, role: out.role, inviter: user.email });
    } catch {
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
      if (!canInviteAs(actor, invite.role)) return "role" as const;
      return (await cancelInvite(tx, project, inviteId, new Date())) ? ("canceled" as const) : ("missing" as const);
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
      if (!canManagePerson(actor, user.id, person) || !canGrant(actor, role)) return "role" as const;
      return (await setPersonRole(tx, project, target, role)) ? ("role_saved" as const) : ("missing" as const);
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
      if (!canManagePerson(actor, user.id, person)) return "role" as const;
      return (await removePerson(tx, project, target)) ? ("removed" as const) : ("missing" as const);
    });
  }).catch(projectActionError);
  redirect(peoplePath(tenant, project, notice));
}
