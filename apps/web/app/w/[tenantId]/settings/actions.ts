"use server";

import { closeWorkspace, disconnectConnection, sendDisconnectEmails } from "@supahound/core/datacontrols/flow";
import { NotAMemberError } from "@supahound/core/db/user";
import { revokeGrant } from "@supahound/core/supabase/oauth";
import { connectionId, tenantId as parseTenantId, type ConnectionId, type TenantId } from "@supahound/core/tenancy/scope";
import { env } from "cloudflare:workers";
import { notFound, redirect } from "next/navigation";
import { mode, syncBillingAfterChange } from "../../../../lib/billing";
import { closeRedirect, disconnectRedirect, parseBack } from "../../../../lib/dataControls";
import { withPool } from "../../../../lib/db";
import { oauthClient, vault } from "../../../../lib/oauth";
import { stripeGateway } from "../../../../lib/stripe";
import { requireUser } from "../../../../lib/supabase";

// Data controls (decision 037). Not behind the paid gate on purpose: a workspace that does not pay
// can still disconnect Supabase and close. The core functions check the role inside the
// transaction that writes, and RLS refuses the same writes.

function parseOr404<T>(parse: (v: string) => T, value: FormDataEntryValue | null): T {
  try {
    return parse(String(value ?? ""));
  } catch {
    notFound();
  }
}

// A workspace owner or admin disconnects one Supabase connection after typing its name. Every
// person on the affected projects gets an email; the history stays 30 days (longer while the
// workspace pays).
export async function disconnectAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant: TenantId = parseOr404(parseTenantId, formData.get("tenantId"));
  const connection: ConnectionId = parseOr404(connectionId, formData.get("connectionId"));
  const back = parseBack(formData.get("back"));
  const out = await withPool(async (pool) => {
    const r = await disconnectConnection(
      { pool, vault: vault(), revoke: (refreshToken) => revokeGrant(oauthClient(), refreshToken, env.SUPABASE_API_URL) },
      { user: user.id, tenant, connection, typedLabel: String(formData.get("confirmLabel") ?? "") },
    );
    if (r.notice) {
      await sendDisconnectEmails(pool, tenant, r.notice, "user", user.email, {
        send: (m) => env.EMAIL.send(m),
        from: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME },
        appUrl: env.APP_URL,
      });
    }
    // Paused projects are not billed: seat model, bill fewer seats now (pro rata); per-project model,
    // their subscriptions cancel at the end of the paid period (decision 041).
    if (r.projectsPaused > 0) await syncBillingAfterChange(pool, tenant);
    return r;
  }).catch((err: unknown) => {
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });
  redirect(disconnectRedirect(tenant, back, connection, out));
}

// The workspace owner closes the workspace after typing its name. Stripe first: the subscription
// cancels at the end of its period.
export async function closeWorkspaceAction(formData: FormData): Promise<void> {
  const user = await requireUser();
  const tenant: TenantId = parseOr404(parseTenantId, formData.get("tenantId"));
  const typedName = String(formData.get("confirmName") ?? "");
  const result = await withPool((pool) =>
    closeWorkspace({ pool, stripe: mode() === "stripe" ? stripeGateway() : null, now: () => new Date() }, { user: user.id, tenant, typedName }),
  ).catch((err: unknown) => {
    if (err instanceof NotAMemberError) notFound();
    // Stripe or the database failed before the closure was saved: nothing was closed. IDs only
    // in the log, never error text.
    console.log(JSON.stringify({ event: "close_workspace_failed", tenant_id: tenant }));
    return "failed" as const;
  });
  redirect(closeRedirect(tenant, result));
}
