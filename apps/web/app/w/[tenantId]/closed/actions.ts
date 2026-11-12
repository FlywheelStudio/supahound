"use server";

import { reopenClosedWorkspace } from "@supahound/core/datacontrols/flow";
import { NotAMemberError } from "@supahound/core/db/user";
import { tenantId as parseTenantId, type TenantId } from "@supahound/core/tenancy/scope";
import { notFound, redirect } from "next/navigation";
import { reopenRedirect } from "../../../../lib/dataControls";
import { withPool } from "../../../../lib/db";
import { requireUser } from "../../../../lib/supabase";

// The workspace owner reopens a closed workspace before its purge (decision 037). Polling
// resumes; the canceled subscription means the gate then asks for a card again.
export async function reopenAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  let tenant: TenantId;
  try {
    tenant = parseTenantId(String(formData.get("tenantId") ?? ""));
  } catch {
    notFound();
  }
  const result = await withPool((pool) => reopenClosedWorkspace(pool, { user: user.id, tenant, now: new Date() })).catch((err: unknown) => {
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });
  redirect(reopenRedirect(tenant, result));
}
