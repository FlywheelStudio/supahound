"use server";

import { createOAuthState } from "@supahound/core/db/repo";
import { NotAMemberError, withTenantForUser } from "@supahound/core/db/user";
import { authorizeUrl, newState, pkcePair, sha256Hex, STATE_TTL_SECONDS } from "@supahound/core/supabase/oauth";
import { tenantId as parseTenantId } from "@supahound/core/tenancy/scope";
import { notFound, redirect } from "next/navigation";
import { withPool } from "../../../lib/db";
import { oauthClient } from "../../../lib/oauth";
import { requireUser } from "../../../lib/supabase";

// Starts "Connect Supabase". Owners and admins only. The state is stored hashed and bound to
// this user and workspace; the callback consumes it once (decision 012).
export async function startConnect(formData: FormData): Promise<void> {
  const user = await requireUser();
  let tenant;
  try {
    tenant = parseTenantId(String(formData.get("tenantId") ?? ""));
  } catch {
    notFound();
  }
  const state = newState(tenant);
  const { verifier, challenge } = pkcePair();
  const allowed = await withPool((pool) =>
    withTenantForUser(pool, user.id, tenant, async (tx, role) => {
      if (role === "member") return false;
      await createOAuthState(tx, {
        userId: user.id, stateHash: sha256Hex(state), codeVerifier: verifier,
        expiresAt: new Date(Date.now() + STATE_TTL_SECONDS * 1000),
      });
      return true;
    }),
  ).catch((err: unknown) => {
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });
  if (!allowed) redirect(`/w/${tenant}?error=role`);
  redirect(authorizeUrl(oauthClient(), state, challenge));
}
