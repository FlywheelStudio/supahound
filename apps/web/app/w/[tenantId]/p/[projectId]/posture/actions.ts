"use server";

import { requestPostureScan } from "@supahound/core/db/posture";
import type { ProjectId, TenantId } from "@supahound/core/tenancy/scope";
import { redirect } from "next/navigation";
import { withPool } from "../../../../../../lib/db";
import { canScan, handleScanNow, SCAN_COOLDOWN_SECONDS } from "../../../../../../lib/posture";
import { paidProject, parseIds, projectActionError } from "../../../../../../lib/projectPage";
import { requireUser } from "../../../../../../lib/supabase";

// "Scan now" (issue #11, decision 038): the project's owners, admins and editors queue a posture
// scan; the next poll runs it. The role is checked in the same transaction as the write, and RLS
// refuses the write for any other role. Logic and tests: lib/posture.ts.
export async function scanNowAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project }: { tenant: TenantId; project: ProjectId } = parseIds(
    String(formData.get("tenantId") ?? ""),
    String(formData.get("projectId") ?? ""),
  );
  const path = await withPool((pool) =>
    handleScanNow(tenant, project, {
      request: () =>
        paidProject(pool, user.id, tenant, project, async (tx, role) => {
          if (!canScan(role)) return { allowed: false, outcome: null };
          return { allowed: true, outcome: await requestPostureScan(tx, project, user.id, SCAN_COOLDOWN_SECONDS) };
        }),
    }),
  ).catch(projectActionError);
  redirect(path);
}
