import { billingPath, completeVerification } from "@supahound/core/billing/flow";
import { NotAMemberError, withTenantForUser } from "@supahound/core/db/user";
import { tenantId as parseTenantId, type TenantId } from "@supahound/core/tenancy/scope";
import { NextResponse, type NextRequest } from "next/server";
import { flowDeps } from "../../../../../lib/billing";
import { withPool } from "../../../../../lib/db";
import { currentUser } from "../../../../../lib/supabase";

// Stripe Checkout sends the browser here after the card step. The webhook finishes the same
// session; whichever runs first starts the trial, and the other gets the same answer.
export async function GET(request: NextRequest, { params }: { params: Promise<{ tenantId: string }> }) {
  const go = (path: string) => NextResponse.redirect(new URL(path, request.nextUrl.origin), 303);
  const user = await currentUser();
  if (!user) return go("/login");
  let tenant: TenantId;
  try {
    tenant = parseTenantId((await params).tenantId);
  } catch {
    return go("/app");
  }
  const sessionId = request.nextUrl.searchParams.get("session_id") ?? "";
  if (!/^cs_[A-Za-z0-9_]{1,200}$/.test(sessionId)) return go(billingPath(tenant, "error"));

  try {
    const result = await withPool(async (pool) => {
      // Only a member may finish their workspace's checkout from the browser.
      await withTenantForUser(pool, user.id, tenant, async () => undefined);
      return (await completeVerification(flowDeps(pool), sessionId, tenant)).result;
    });
    if (result === "subscribed") return go(`/w/${tenant}?welcome=1`);
    return go(billingPath(tenant, result === "ignored" ? "error" : result));
  } catch (err) {
    if (err instanceof NotAMemberError) return go("/app");
    console.log(JSON.stringify({ event: "billing_return_failed", tenant_id: tenant }));
    return go(billingPath(tenant, "error"));
  }
}
