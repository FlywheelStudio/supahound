"use server";

import { setEmailAlerts } from "@supahound/core/db/repo";
import type { ProjectId, TenantId } from "@supahound/core/tenancy/scope";
import { redirect } from "next/navigation";
import { handleAlertSetting } from "../../../../../../lib/alerts";
import { withPool } from "../../../../../../lib/db";
import { can } from "../../../../../../lib/people";
import { paidProject, parseIds, projectActionError } from "../../../../../../lib/projectPage";
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
