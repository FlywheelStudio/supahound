import { storeConnection } from "@supahound/core/db/connections";
import { consumeOAuthState } from "@supahound/core/db/repo";
import { NotAMemberError } from "@supahound/core/db/user";
import { listSupabaseProjects } from "@supahound/core/supabase/management";
import { exchangeCode } from "@supahound/core/supabase/oauth";
import { env } from "cloudflare:workers";
import { NextResponse, type NextRequest } from "next/server";
import { handleOAuthCallback } from "../../../../lib/connect";
import { withPool } from "../../../../lib/db";
import { paidTenant } from "../../../../lib/billing";
import { oauthClient, vault } from "../../../../lib/oauth";
import { currentUser } from "../../../../lib/supabase";

// Supabase redirects here after consent. Logic and its tests: lib/connect.ts.
export async function GET(request: NextRequest) {
  const user = await currentUser();
  const path = await withPool((pool) =>
    handleOAuthCallback(request.nextUrl.searchParams, user?.id ?? null, {
      consume: (u, t, hash) => paidTenant(pool, u, t, (tx) => consumeOAuthState(tx, u, hash, new Date())),
      exchange: (code, verifier) => exchangeCode(oauthClient(), code, verifier),
      // Decision 037: the new grant's project list, read before the transaction, lets a reconnect of
      // the same organization take back a disconnected connection and keep its history. If the
      // list fails, a new connection is stored and nothing is taken back.
      store: async (u, t, credentials) => {
        const refs = await listSupabaseProjects(credentials.accessToken, { baseUrl: env.SUPABASE_API_URL })
          .then((ps) => ps.map((p) => p.ref), () => null);
        const out = await paidTenant(pool, u, t, (tx) => storeConnection(tx, vault(), JSON.stringify(credentials), refs, new Date()));
        return out.reattached;
      },
      isNotAMember: (err) => err instanceof NotAMemberError,
    }),
  );
  return NextResponse.redirect(new URL(path, request.nextUrl.origin));
}
