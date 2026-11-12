"use server";

import { cancelRemoval, scheduleRemoval } from "@supahound/core/db/removal";
import { listConnections, listProjects, watchProjects } from "@supahound/core/db/repo";
import { NotAMemberError } from "@supahound/core/db/user";
import { accessTokenInTx } from "@supahound/core/supabase/credentials";
import { listSupabaseProjects } from "@supahound/core/supabase/management";
import { connectionId, projectId, tenantId as parseTenantId, type ConnectionId, type ProjectId, type TenantId } from "@supahound/core/tenancy/scope";
import { env } from "cloudflare:workers";
import { notFound, redirect } from "next/navigation";
import { withPool } from "../../../../lib/db";
import { paidTenant, syncBillingAfterChange, toBillingIfUnpaid } from "../../../../lib/billing";
import { oauthClient, vault } from "../../../../lib/oauth";
import { handleWatch, keepOutcome, picksPath, removalOutcome } from "../../../../lib/picker";
import { requireUser } from "../../../../lib/supabase";

function parseOr404<T>(parse: (v: string) => T, value: FormDataEntryValue | null): T {
  try {
    return parse(String(value ?? ""));
  } catch {
    notFound();
  }
}

function memberOr404(err: unknown): never {
  toBillingIfUnpaid(err);
  if (err instanceof NotAMemberError) notFound();
  throw err;
}

// Owners and admins add projects from a connection. Logic and tests: lib/picker.ts.
export async function watchProjectsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant: TenantId = parseOr404(parseTenantId, formData.get("tenantId"));
  const connection: ConnectionId = parseOr404(connectionId, formData.get("connectionId"));
  const path = await withPool((pool) =>
    handleWatch(tenant, connection, formData.getAll("ref"), {
      prepare: (conn) =>
        paidTenant(pool, user.id, tenant, async (tx, role) => {
          if (role === "member") return { role, token: null };
          const owned = (await listConnections(tx)).some((c) => c.id === conn);
          return { role, token: owned ? await accessTokenInTx(tx, vault(), conn, oauthClient(), new Date()) : null };
        }),
      list: (token) => listSupabaseProjects(token, { baseUrl: env.SUPABASE_API_URL }),
      insert: (conn, projects) =>
        paidTenant(pool, user.id, tenant, (tx, role) => (role === "member" ? Promise.resolve(null) : watchProjects(tx, conn, projects))),
    }).then(async (next) => {
      if (next.includes("added=")) await syncBillingAfterChange(pool, tenant);
      return next;
    }),
  ).catch(memberOr404);
  redirect(path);
}

// The project's Owner, or a workspace owner or admin, removes a project after typing its name.
// Decision 042: nothing is deleted now. The project stays active until its subscription's period
// ends; the data job deletes it 7 days later unless someone keeps it. Reconcile then cancels the
// subscription at its period end.
export async function removeProjectAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant: TenantId = parseOr404(parseTenantId, formData.get("tenantId"));
  const project: ProjectId = parseOr404(projectId, formData.get("projectId"));
  const typed = String(formData.get("confirmName") ?? "");
  const outcome = await withPool((pool) =>
    paidTenant(pool, user.id, tenant, async (tx, role) => {
      const found = (await listProjects(tx)).find((p) => p.id === project) ?? null;
      const result = removalOutcome(role, found, typed);
      if (result === "removed" && !(await scheduleRemoval(tx, project, new Date()))) return "missing" as const;
      return result;
    }).then(async (r) => {
      if (r === "removed") await syncBillingAfterChange(pool, tenant);
      return r;
    }),
  ).catch(memberOr404);
  redirect(outcome === "mismatch" ? `${picksPath(tenant, outcome)}&remove=${project}` : picksPath(tenant, outcome));
}

// "Keep project" (decision 042): the same people who may remove it clear the removal before the
// data job deletes it. Reconcile then resumes the subscription, or after the period creates a new
// one. Returns to the page the button was on.
export async function keepProjectAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant: TenantId = parseOr404(parseTenantId, formData.get("tenantId"));
  const project: ProjectId = parseOr404(projectId, formData.get("projectId"));
  const outcome = await withPool((pool) =>
    paidTenant(pool, user.id, tenant, async (tx, role) => {
      const found = (await listProjects(tx)).find((p) => p.id === project) ?? null;
      const result = keepOutcome(role, found);
      if (result === "kept" && !(await cancelRemoval(tx, project))) return "missing" as const;
      return result;
    }).then(async (r) => {
      if (r === "kept") await syncBillingAfterChange(pool, tenant);
      return r;
    }),
  ).catch(memberOr404);
  if (formData.get("from") === "plan" && outcome === "kept") redirect(`/w/${tenant}/p/${project}/settings/plan?kept=1`);
  redirect(picksPath(tenant, outcome));
}
