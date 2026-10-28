import type { Credentials } from "@supahound/core/supabase/oauth";
import { sha256Hex, tenantFromState } from "@supahound/core/supabase/oauth";
import type { TenantId, UserId } from "@supahound/core/tenancy/scope";

// The Supabase OAuth callback, as a pure function so every branch is testable (decision 012).
// Order matters: the state is consumed (single-use, bound to user + tenant) BEFORE the code is
// exchanged, so a replayed callback URL can never store a second connection.

export interface CallbackDeps {
  // Returns the PKCE verifier if this user may consume this state in this tenant; null if the
  // state is unknown, used, expired or someone else's. Throws NotAMemberError for non-members.
  consume: (user: UserId, tenant: TenantId, stateHash: string) => Promise<string | null>;
  exchange: (code: string, verifier: string) => Promise<Credentials>;
  store: (user: UserId, tenant: TenantId, credentials: Credentials) => Promise<void>;
  isNotAMember: (err: unknown) => boolean;
}

// Returns the path to redirect to.
export async function handleOAuthCallback(params: URLSearchParams, user: UserId | null, deps: CallbackDeps): Promise<string> {
  if (!user) return "/login";
  const state = params.get("state") ?? "";
  const tenant = tenantFromState(state);
  if (!tenant) return "/app?error=connect";
  const code = params.get("code");
  if (!code) return `/w/${tenant}?error=consent`;

  try {
    const verifier = await deps.consume(user, tenant, sha256Hex(state));
    if (!verifier) return `/w/${tenant}?error=connect`;
    const credentials = await deps.exchange(code, verifier);
    await deps.store(user, tenant, credentials);
    return `/w/${tenant}?connected=1`;
  } catch (err) {
    if (deps.isNotAMember(err)) return "/app";
    return `/w/${tenant}?error=connect`;
  }
}
