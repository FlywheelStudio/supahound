"use server";

import { getBilling } from "@supahound/core/db/billing";
import type { ProjectId, TenantId } from "@supahound/core/tenancy/scope";
import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";
import { withPool } from "../../../../../../../lib/db";
import { projectPath } from "../../../../../../../lib/nav";
import { paidProject, parseIds, projectActionError } from "../../../../../../../lib/projectPage";
import { canManageBilling } from "../../../../../../../lib/projectBilling";
import { stripeGateway } from "../../../../../../../lib/stripe";
import { requireUser } from "../../../../../../../lib/supabase";

// The Stripe Billing Portal from a project's Plan & billing page (decision 041). The portal covers
// the whole Stripe customer (the card and every project's invoices), so only workspace owners and
// admins open it, as on the workspace billing page (decision 036: billing keeps the workspace role).
// It returns to this project's page.
export async function openProjectPortalAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const { tenant, project }: { tenant: TenantId; project: ProjectId } = parseIds(
    String(formData.get("tenantId") ?? ""),
    String(formData.get("projectId") ?? ""),
  );
  const customer = await withPool((pool) =>
    paidProject(pool, user.id, tenant, project, async (tx, _role, workspaceRole) =>
      canManageBilling(workspaceRole) ? (await getBilling(tx)).customerId : null),
  ).catch(projectActionError);
  const back = projectPath(tenant, project, "plan");
  if (!customer) redirect(`${back}?error=role`);
  redirect(await stripeGateway().portalUrl(customer, `${env.APP_URL}${back}`));
}
