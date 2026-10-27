import { consumeOAuthState, createConnection } from "@guardbase/core/db/repo";
import { NotAMemberError, withTenantForUser } from "@guardbase/core/db/user";
import { exchangeCode, sha256Hex, tenantFromState } from "@guardbase/core/supabase/oauth";
import { NextResponse, type NextRequest } from "next/server";
import { withPool } from "../../../../lib/db";
import { oauthClient, vault } from "../../../../lib/oauth";
import { currentUser } from "../../../../lib/supabase";

// Supabase redirects here after consent. The state must belong to THIS signed-in user and to a
// workspace they are a member of, unused and unexpired; otherwise nothing is stored. The code
// exchange runs outside any transaction.
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const back = (path: string) => NextResponse.redirect(new URL(path, url.origin));
  const user = await currentUser();
  if (!user) return back("/login");

  const state = url.searchParams.get("state") ?? "";
  const tenant = tenantFromState(state);
  if (!tenant) return back("/app?error=connect");
  const code = url.searchParams.get("code");
  if (!code) return back(`/w/${tenant}?error=consent`);

  return withPool(async (pool) => {
    try {
      const verifier = await withTenantForUser(pool, user.id, tenant, (tx) =>
        consumeOAuthState(tx, user.id, sha256Hex(state), new Date()),
      );
      if (!verifier) return back(`/w/${tenant}?error=connect`);

      const credentials = await exchangeCode(oauthClient(), code, verifier);
      await withTenantForUser(pool, user.id, tenant, (tx) =>
        createConnection(tx, vault(), { label: "Supabase", token: JSON.stringify(credentials) }),
      );
      return back(`/w/${tenant}?connected=1`);
    } catch (err) {
      if (err instanceof NotAMemberError) return back("/app");
      return back(`/w/${tenant}?error=connect`);
    }
  });
}
