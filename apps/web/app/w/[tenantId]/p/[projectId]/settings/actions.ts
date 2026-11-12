"use server";

import { setEmailAlerts } from "@supahound/core/db/repo";
import { NotAMemberError } from "@supahound/core/db/user";
import type { ProjectId, TenantId } from "@supahound/core/tenancy/scope";
import { notFound, redirect } from "next/navigation";
import { handleAlertSetting } from "../../../../../../lib/alerts";
import { paidTenant, toBillingIfUnpaid } from "../../../../../../lib/billing";
import { withPool } from "../../../../../../lib/db";
import { parseIds } from "../../../../../../lib/projectPage";
import { requireUser } from "../../../../../../lib/supabase";

// Owners and admins set which severities email the workspace's members for one project
// (decision 030). The role is checked in the same transaction as the write. Logic and tests:
// lib/alerts.ts.
export async function setEmailAlertsAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project }: { tenant: TenantId; project: ProjectId } = parseIds(
    String(formData.get("tenantId") ?? ""),
    String(formData.get("projectId") ?? ""),
  );
  const path = await withPool((pool) =>
    handleAlertSetting(tenant, project, formData.get("level"), {
      apply: (level) =>
        paidTenant(pool, user.id, tenant, async (tx, role) => ({
          role,
          updated: role === "member" ? false : await setEmailAlerts(tx, project, level),
        })),
    }),
  ).catch((err: unknown) => {
    toBillingIfUnpaid(err);
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });
  redirect(path);
}
