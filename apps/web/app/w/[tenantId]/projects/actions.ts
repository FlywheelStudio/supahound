"use server";

import { listConnections, listProjects, removeProject, setEmailAlerts, watchProjects } from "@supahound/core/db/repo";
import { NotAMemberError } from "@supahound/core/db/user";
import { accessTokenInTx } from "@supahound/core/supabase/credentials";
import { listSupabaseProjects } from "@supahound/core/supabase/management";
import { connectionId, projectId, tenantId as parseTenantId, type ConnectionId, type ProjectId, type TenantId } from "@supahound/core/tenancy/scope";
import { env } from "cloudflare:workers";
import { notFound, redirect } from "next/navigation";
import { withPool } from "../../../../lib/db";
import { paidTenant, syncSeatsAfterChange, toBillingIfUnpaid } from "../../../../lib/billing";
import { oauthClient, vault } from "../../../../lib/oauth";
import { handleAlertSetting } from "../../../../lib/alerts";
import { handleWatch, picksPath, removalOutcome } from "../../../../lib/picker";
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
      if (next.includes("added=")) await syncSeatsAfterChange(pool, tenant);
      return next;
    }),
  ).catch(memberOr404);
  redirect(path);
}

// Owners and admins remove a project after typing its name. Incidents, findings and poll runs
// are deleted; audit rows stay (decision 022).
export async function removeProjectAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant: TenantId = parseOr404(parseTenantId, formData.get("tenantId"));
  const project: ProjectId = parseOr404(projectId, formData.get("projectId"));
  const typed = String(formData.get("confirmName") ?? "");
  const outcome = await withPool((pool) =>
    paidTenant(pool, user.id, tenant, async (tx, role) => {
      const found = (await listProjects(tx)).find((p) => p.id === project) ?? null;
      const result = removalOutcome(role, found, typed);
      if (result === "removed" && !(await removeProject(tx, project))) return "missing" as const;
      return result;
    }).then(async (r) => {
      if (r === "removed") await syncSeatsAfterChange(pool, tenant);
      return r;
    }),
  ).catch(memberOr404);
  redirect(outcome === "mismatch" ? `${picksPath(tenant, outcome)}&remove=${project}` : picksPath(tenant, outcome));
}

// Owners and admins set which severities email the workspace's members for one project.
// Logic and tests: lib/alerts.ts.
export async function setEmailAlertsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant: TenantId = parseOr404(parseTenantId, formData.get("tenantId"));
  const project: ProjectId = parseOr404(projectId, formData.get("projectId"));
  const path = await withPool((pool) =>
    handleAlertSetting(tenant, formData.get("level"), {
      apply: (level) =>
        paidTenant(pool, user.id, tenant, async (tx, role) => ({
          role,
          updated: role === "member" ? false : await setEmailAlerts(tx, project, level),
        })),
    }),
  ).catch(memberOr404);
  redirect(path);
}
