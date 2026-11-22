import { logSecurityEvent, recordSignIn } from "@supahound/core/db/securityEvents";
import { verifiedUserId } from "@supahound/core/tenancy/scope";
import { NextResponse, type NextRequest } from "next/server";
import { withPool } from "../../../lib/db";
import { isSignInType } from "../../../lib/email/magicLink";
import { NEXT_COOKIE, safeNext } from "../../../lib/security";
import { supabaseServer } from "../../../lib/supabase";

// The link in the sign-in email lands here. The token hash is verified server-side and the
// session is stored in an httpOnly cookie; no token ever sits in the URL fragment.
export async function GET(request: NextRequest) {
  const url = request.nextUrl;
  const tokenHash = url.searchParams.get("token_hash");
  const type = url.searchParams.get("type") ?? "";
  const next = safeNext(url.searchParams.get("next") ?? request.cookies.get(NEXT_COOKIE)?.value);

  if (tokenHash && isSignInType(type)) {
    const supabase = await supabaseServer();
    const { error } = await supabase.auth.verifyOtp({ token_hash: tokenHash, type });
    if (!error) {
      await recordSignInFrom(supabase);
      const res = NextResponse.redirect(new URL(next, url.origin));
      res.cookies.delete(NEXT_COOKIE);
      return res;
    }
    if (error) logSecurityEvent("sign_in_failed");
  }
  return NextResponse.redirect(new URL("/login?error=link", url.origin));
}

// Decision 044: a sign-in event in each workspace the user belongs to. The user comes from
// getClaims() (a verified JWT), never from the verifyOtp response. Best effort: a failure here is
// logged and never blocks the sign-in.
async function recordSignInFrom(supabase: Awaited<ReturnType<typeof supabaseServer>>): Promise<void> {
  try {
    const { data, error } = await supabase.auth.getClaims();
    const sub = data?.claims?.sub;
    if (error || typeof sub !== "string") return;
    const user = verifiedUserId(sub);
    await withPool((pool) => recordSignIn(pool, user));
  } catch {
    console.log(JSON.stringify({ event: "sign_in_record_failed" }));
  }
}
