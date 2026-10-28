"use server";

import { env } from "cloudflare:workers";
import { redirect } from "next/navigation";
import { supabaseServer } from "../../lib/supabase";

const EMAIL = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;

export async function sendMagicLink(formData: FormData): Promise<void> {
  const email = String(formData.get("email") ?? "").trim().toLowerCase();
  if (!EMAIL.test(email) || email.length > 254) redirect("/login?error=email");

  const supabase = await supabaseServer();
  const { error } = await supabase.auth.signInWithOtp({
    email,
    options: { emailRedirectTo: new URL("/auth/confirm", env.APP_URL).toString() },
  });
  // Same response whether or not the address has an account, so the form cannot be used to
  // discover who uses Supahound. Supabase rate-limits sends per address and per project.
  redirect(error?.status === 429 ? "/login?error=rate" : "/login?sent=1");
}
