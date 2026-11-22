"use server";

import { markPublicTable, unmarkPublicTable } from "@supahound/core/db/detectionSettings";
import { requestPostureScan } from "@supahound/core/db/posture";
import type { ProjectId, TenantId } from "@supahound/core/tenancy/scope";
import { redirect } from "next/navigation";
import { withPool } from "../../../../../../lib/db";
import { canMarkPublic, handleMarkPublic, handleUnmarkPublic } from "../../../../../../lib/detectionSettings";
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

// Mark a table intentionally public (issue #160, decision 045): the project's owners and admins.
// Detector 11 stops watching it from the next poll. The role is checked in the same transaction as
// the write, RLS refuses any other role, and the change is audited. Logic and tests:
// lib/detectionSettings.ts.
export async function markPublicAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project }: { tenant: TenantId; project: ProjectId } = parseIds(
    String(formData.get("tenantId") ?? ""),
    String(formData.get("projectId") ?? ""),
  );
  const path = await withPool((pool) =>
    handleMarkPublic(tenant, project, formData.get("table"), {
      mark: (table) =>
        paidProject(pool, user.id, tenant, project, async (tx, role) => {
          if (!canMarkPublic(role)) return { allowed: false, outcome: null };
          return { allowed: true, outcome: await markPublicTable(tx, project, table, user.id) };
        }),
    }),
  ).catch(projectActionError);
  redirect(path);
}

// Remove the mark: the project's owners and admins. Alerts for the table resume from the next poll.
export async function unmarkPublicAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project }: { tenant: TenantId; project: ProjectId } = parseIds(
    String(formData.get("tenantId") ?? ""),
    String(formData.get("projectId") ?? ""),
  );
  const path = await withPool((pool) =>
    handleUnmarkPublic(tenant, project, formData.get("table"), {
      unmark: (table) =>
        paidProject(pool, user.id, tenant, project, async (tx, role) => {
          if (!canMarkPublic(role)) return { allowed: false, removed: false };
          return { allowed: true, removed: await unmarkPublicTable(tx, project, table, user.id) };
        }),
    }),
  ).catch(projectActionError);
  redirect(path);
}
