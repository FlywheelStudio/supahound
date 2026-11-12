"use server";

import { env } from "cloudflare:workers";
import { cookies } from "next/headers";
import { redirect } from "next/navigation";
import { NEXT_COOKIE, NEXT_COOKIE_MAX_AGE, safeNext } from "../../lib/security";
import { supabaseServer } from "../../lib/supabase";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendMagicLink(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) redirect("/login?error=email");

  // A page that sent the user here to sign in (an invite) is where the link brings them back.
  const next = safeNext(String(formData.get("next") ?? ""), "");
  const store = await cookies();
  if (next) {
    store.set(NEXT_COOKIE, next, {
      httpOnly: true, sameSite: "lax", secure: env.APP_URL.startsWith("https://"), path: "/", maxAge: NEXT_COOKIE_MAX_AGE,
    });
  } else {
    store.delete(NEXT_COOKIE);
  }

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: new URL("/auth/confirm", env.APP_URL).toString() },
  });
  // Same response whether or not the address has an account, so the form cannot be used to
  // discover who uses Supahound. Supabase rate-limits sends per address and per project.
  redirect(error?.status === 429 ? "/login?error=rate" : "/login?sent=1");
}
