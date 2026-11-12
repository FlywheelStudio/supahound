import { NextResponse, type NextRequest } from "next/server";
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
      const res = NextResponse.redirect(new URL(next, url.origin));
      res.cookies.delete(NEXT_COOKIE);
      return res;
    }
  }
  return NextResponse.redirect(new URL("/login?error=link", url.origin));
}
