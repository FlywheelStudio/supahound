import { verifiedUserId, type UserId } from "@supahound/core/tenancy/scope";
import { createServerClient } from "@supabase/ssr";
import { env } from "cloudflare:workers";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";

// Supabase Auth on the server (decision 009). The user ID comes only from getClaims(), which
// verifies the JWT signature; never from getSession() or request input.

export async function supabaseServer() {
  const store = await cookies();
  return createServerClient(env.SUPABASE_URL, env.SUPABASE_PUBLISHABLE_KEY, {
    cookies: {
      getAll: () => store.getAll(),
      setAll: (list) => {
        try {
          for (const { name, value, options } of list) store.set(name, value, options);
        } catch {
          // Server Components cannot set cookies; the middleware refreshes the session.
        }
      },
    },
  });
}

export interface SessionUser {
  id: UserId;
  email: string | null;
}

export async function currentUser(): Promise<SessionUser | null> {
  const supabase = await supabaseServer();
  const { data, error } = await supabase.auth.getClaims();
  const claims = data?.claims;
  if (error || !claims || typeof claims.sub !== "string") return null;
  try {
    return { id: verifiedUserId(claims.sub), email: typeof claims.email === "string" ? claims.email : null };
  } catch {
    return null;
  }
}

export async function requireUser(): Promise<SessionUser> {
  const user = await currentUser();
  if (!user) redirect("/login");
  return user;
}
