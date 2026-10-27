import { createServerClient } from "@supabase/ssr";
import { env } from "cloudflare:workers";
import { NextResponse, type NextRequest } from "next/server";
import { isSafeMethod, isSameOrigin, SIGNED_ROUTES } from "./lib/security";

// 1. Reject cross-origin state changes (CSRF). Signed server-to-server routes are exempt and
//    verify their own signatures.
// 2. Refresh the Supabase session cookie.
// 3. Never let a shared cache store a signed-in page: one user's workspace must never be
//    served to another.
const PRIVATE_PREFIXES = ["/app", "/w/", "/onboarding", "/auth/", "/api/supabase/"];

export async function middleware(request: NextRequest) {
  const path = request.nextUrl.pathname;
  const signed = (SIGNED_ROUTES as readonly string[]).includes(path);

  if (!isSafeMethod(request.method) && !signed && !isSameOrigin(request, env.APP_URL)) {
    return new NextResponse("Forbidden", { status: 403 });
  }
  if (signed) return NextResponse.next();

  let response = NextResponse.next({ request });
  const supabase = createServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => request.cookies.getAll(),
      setAll: (list) => {
        for (const { name, value } of list) request.cookies.set(name, value);
        response = NextResponse.next({ request });
        for (const { name, value, options } of list) response.cookies.set(name, value, options);
      },
    },
  });
  await supabase.auth.getClaims();

  if (PRIVATE_PREFIXES.some((p) => path === p || path.startsWith(p))) {
    response.headers.set("Cache-Control", "private, no-store");
  }
  return response;
}

export const config = {
  matcher: ["/((?!_next/static|_next/image|favicon.ico).*)"],
};
