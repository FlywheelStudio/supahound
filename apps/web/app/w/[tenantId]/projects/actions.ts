"use server";

import { listConnections, listProjects, removeProject, watchProjects } from "@supahound/core/db/repo";
import { NotAMemberError, withTenantForUser } from "@supahound/core/db/user";
import { accessTokenInTx } from "@supahound/core/supabase/credentials";
import { listSupabaseProjects } from "@supahound/core/supabase/management";
import { connectionId, projectId, tenantId as parseTenantId, type ConnectionId, type ProjectId, type TenantId } from "@supahound/core/tenancy/scope";
import { env } from "cloudflare:workers";
import { notFound, redirect } from "next/navigation";
import { withPool } from "../../../../lib/db";
import { oauthClient, vault } from "../../../../lib/oauth";
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
        withTenantForUser(pool, user.id, tenant, async (tx, role) => {
          if (role === "member") return { role, token: null };
          const owned = (await listConnections(tx)).some((c) => c.id === conn);
          return { role, token: owned ? await accessTokenInTx(tx, vault(), conn, oauthClient(), new Date()) : null };
        }),
      list: (token) => listSupabaseProjects(token, { baseUrl: env.SUPABASE_API_URL }),
      insert: (conn, projects) =>
        withTenantForUser(pool, user.id, tenant, (tx, role) => (role === "member" ? Promise.resolve(null) : watchProjects(tx, conn, projects))),
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
    withTenantForUser(pool, user.id, tenant, async (tx, role) => {
      const found = (await listProjects(tx)).find((p) => p.id === project) ?? null;
      const result = removalOutcome(role, found, typed);
      if (result === "removed" && !(await removeProject(tx, project))) return "missing" as const;
      return result;
    }),
  ).catch(memberOr404);
  redirect(outcome === "mismatch" ? `${picksPath(tenant, outcome)}&remove=${project}` : picksPath(tenant, outcome));
}
