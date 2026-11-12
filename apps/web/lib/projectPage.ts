import type { Access } from "@supahound/core/billing/policy";
import { projectRole, type ProjectRole } from "@supahound/core/db/people";
import { projectTiers, type ProjectTier } from "@supahound/core/db/billing";
import { listProjects, type ProjectSummary } from "@supahound/core/db/repo";
import type { TenantTx } from "@supahound/core/db/tenant";
import { NotAMemberError, type Role } from "@supahound/core/db/user";
import { projectId as parseProjectId, tenantId as parseTenantId, type ProjectId, type TenantId, type UserId } from "@supahound/core/tenancy/scope";
import { notFound } from "next/navigation";
import { paidTenant, toBillingIfUnpaid } from "./billing";
import type pg from "pg";
import { withPool } from "./db";
import { requireUser } from "./supabase";

// One loader for every page under /w/[tenantId]/p/[projectId] (issue #98). Membership, the
// project list for the switcher and the page's own data come from ONE paid-gate transaction, so
// a project ID from another workspace is simply absent and the page 404s, exactly like a
// workspace the user does not belong to.

export interface ProjectPageData<T> {
  tenant: TenantId;
  // The workspace role (workspace pages and actions) and the role on this project (decision 036).
  role: Role;
  projectRole: ProjectRole;
  access: Access;
  projects: ProjectSummary[];
  tiers: ProjectTier[];
  project: ProjectSummary;
  extra: T;
}

export function parseIds(rawTenant: string, rawProject: string): { tenant: TenantId; project: ProjectId } {
  try {
    return { tenant: parseTenantId(rawTenant), project: parseProjectId(rawProject) };
  } catch {
    notFound();
  }
}

export async function loadProjectPage<T = null>(
  params: Promise<{ tenantId: string; projectId: string }>,
  extra?: (tx: TenantTx, project: ProjectSummary, role: ProjectRole) => Promise<T>,
): Promise<ProjectPageData<T>> {
  const user = await requireUser();
  const raw = await params;
  const { tenant, project: id } = parseIds(raw.tenantId, raw.projectId);
  const data = await withPool((pool) =>
    paidTenant(pool, user.id, tenant, async (tx, role, access) => {
      const projects = await listProjects(tx);
      // RLS already hides a project the user has no role on; the role check makes the 404 explicit.
      const project = projects.find((p) => p.id === id);
      if (!project || !project.role) return null;
      return {
        tenant, role, projectRole: project.role, access, projects, project,
        tiers: await projectTiers(tx),
        extra: (extra ? await extra(tx, project, project.role) : null) as T,
      };
    }),
  ).catch((err: unknown) => {
    toBillingIfUnpaid(err);
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });
  if (!data) notFound();
  return data;
}

// For project actions: the paid gate, then the user's role on this project in the same
// transaction. No role (another workspace's project, a made-up ID, or a workspace member who was
// not invited to it) throws NotAMemberError, which the caller turns into a 404.
export function paidProject<T>(
  pool: pg.Pool,
  user: UserId,
  tenant: TenantId,
  project: ProjectId,
  fn: (tx: TenantTx, role: ProjectRole, workspaceRole: Role) => Promise<T>,
): Promise<T> {
  return paidTenant(pool, user, tenant, async (tx, workspaceRole) => {
    const role = await projectRole(tx, project);
    if (!role) throw new NotAMemberError();
    return fn(tx, role, workspaceRole);
  });
}

// For .catch() on a project action: unpaid → billing; no role → 404.
export function projectActionError(err: unknown): never {
  toBillingIfUnpaid(err);
  if (err instanceof NotAMemberError) notFound();
  throw err;
}
