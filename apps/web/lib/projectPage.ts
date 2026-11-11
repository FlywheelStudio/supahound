import type { Access } from "@supahound/core/billing/policy";
import { projectTiers, type ProjectTier } from "@supahound/core/db/billing";
import { listProjects, type ProjectSummary } from "@supahound/core/db/repo";
import type { TenantTx } from "@supahound/core/db/tenant";
import { NotAMemberError, type Role } from "@supahound/core/db/user";
import { projectId as parseProjectId, tenantId as parseTenantId, type ProjectId, type TenantId } from "@supahound/core/tenancy/scope";
import { notFound } from "next/navigation";
import { paidTenant, toBillingIfUnpaid } from "./billing";
import { withPool } from "./db";
import { requireUser } from "./supabase";

// One loader for every page under /w/[tenantId]/p/[projectId] (issue #98). Membership, the
// project list for the switcher and the page's own data come from ONE paid-gate transaction, so
// a project ID from another workspace is simply absent and the page 404s, exactly like a
// workspace the user does not belong to.

export interface ProjectPageData<T> {
  tenant: TenantId;
  role: Role;
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
  extra?: (tx: TenantTx, project: ProjectSummary, role: Role) => Promise<T>,
): Promise<ProjectPageData<T>> {
  const user = await requireUser();
  const raw = await params;
  const { tenant, project: id } = parseIds(raw.tenantId, raw.projectId);
  const data = await withPool((pool) =>
    paidTenant(pool, user.id, tenant, async (tx, role, access) => {
      const projects = await listProjects(tx);
      const project = projects.find((p) => p.id === id);
      if (!project) return null;
      return {
        tenant, role, access, projects, project,
        tiers: await projectTiers(tx),
        extra: (extra ? await extra(tx, project, role) : null) as T,
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
