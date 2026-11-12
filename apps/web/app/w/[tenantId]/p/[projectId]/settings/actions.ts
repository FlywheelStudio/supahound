"use server";

import { setEmailAlerts } from "@supahound/core/db/repo";
import { linkDomain, unlinkDomain } from "@supahound/core/db/scanDomains";
import type { ProjectId, TenantId } from "@supahound/core/tenancy/scope";
import { redirect } from "next/navigation";
import { handleAlertSetting } from "../../../../../../lib/alerts";
import { withPool } from "../../../../../../lib/db";
import { can } from "../../../../../../lib/people";
import { paidProject, parseIds, projectActionError } from "../../../../../../lib/projectPage";
import { canLinkDomains, handleLink, handleUnlink } from "../../../../../../lib/scanDomains";
import { requireUser } from "../../../../../../lib/supabase";

// The project's owners, admins and editors set which severities email the project's people
// (decisions 030 and 036). The project role is checked in the same transaction as the write, and
// RLS refuses the update for any other role. Logic and tests: lib/alerts.ts.
export async function setEmailAlertsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project }: { tenant: TenantId; project: ProjectId } = parseIds(
    String(formData.get("tenantId") ?? ""),
    String(formData.get("projectId") ?? ""),
  );
  const path = await withPool((pool) =>
    handleAlertSetting(tenant, project, formData.get("level"), {
      apply: (level) =>
        paidProject(pool, user.id, tenant, project, async (tx, role) => {
          const allowed = can(role, "edit_settings");
          return { allowed, updated: allowed ? await setEmailAlerts(tx, project, level) : false };
        }),
    }),
  ).catch(projectActionError);
  redirect(path);
}

// Attach a verified scan domain to this project (issue #100, decision 040): the project's owners
// and admins. The role is checked in the same transaction as the write; RLS and a trigger refuse
// any other role and any unverified domain. Logic and tests: lib/scanDomains.ts.
export async function linkDomainAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project }: { tenant: TenantId; project: ProjectId } = parseIds(
    String(formData.get("tenantId") ?? ""),
    String(formData.get("projectId") ?? ""),
  );
  const path = await withPool((pool) =>
    handleLink(tenant, project, formData.get("domainId"), {
      link: (domain) =>
        paidProject(pool, user.id, tenant, project, async (tx, role) => {
          if (!canLinkDomains(role)) return { allowed: false, outcome: null };
          return { allowed: true, outcome: await linkDomain(tx, project, domain, user.id) };
        }),
    }),
  ).catch(projectActionError);
  redirect(path);
}

// Detach a scan domain from this project: the project's owners and admins.
export async function unlinkDomainAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project }: { tenant: TenantId; project: ProjectId } = parseIds(
    String(formData.get("tenantId") ?? ""),
    String(formData.get("projectId") ?? ""),
  );
  const path = await withPool((pool) =>
    handleUnlink(tenant, project, formData.get("domainId"), {
      unlink: (domain) =>
        paidProject(pool, user.id, tenant, project, async (tx, role) => {
          if (!canLinkDomains(role)) return { allowed: false, removed: false };
          return { allowed: true, removed: await unlinkDomain(tx, project, domain) };
        }),
    }),
  ).catch(projectActionError);
  redirect(path);
}
