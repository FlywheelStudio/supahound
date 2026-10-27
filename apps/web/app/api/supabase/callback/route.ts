import { consumeOAuthState, createConnection } from "@guardbase/core/db/repo";
import { NotAMemberError, withTenantForUser } from "@guardbase/core/db/user";
import { exchangeCode } from "@guardbase/core/supabase/oauth";
import { NextResponse, type NextRequest } from "next/server";
import { handleOAuthCallback } from "../../../../lib/connect";
import { withPool } from "../../../../lib/db";
import { oauthClient, vault } from "../../../../lib/oauth";
import { currentUser } from "../../../../lib/supabase";

// Supabase redirects here after consent. Logic and its tests: lib/connect.ts.
export async function GET(request: NextRequest) {
  const user = await currentUser();
  const path = await withPool((pool) =>
    handleOAuthCallback(request.nextUrl.searchParams, user?.id ?? null, {
      consume: (u, t, hash) => withTenantForUser(pool, u, t, (tx) => consumeOAuthState(tx, u, hash, new Date())),
      exchange: (code, verifier) => exchangeCode(oauthClient(), code, verifier),
      store: (u, t, credentials) =>
        withTenantForUser(pool, u, t, (tx) => createConnection(tx, vault(), { label: "Supabase", token: JSON.stringify(credentials) })).then(() => undefined),
      isNotAMember: (err) => err instanceof NotAMemberError,
    }),
  );
  return NextResponse.redirect(new URL(path, request.nextUrl.origin));
}
