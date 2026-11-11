import { Webhook } from "standardwebhooks";
import { confirmUrl, isSignInType, renderSignInEmail, type RenderedEmail } from "./magicLink";

// Supabase Auth Send Email Hook: https://supabase.com/docs/guides/auth/auth-hooks/send-email-hook
// Supabase signs the request (Standard Webhooks). We verify it, build our own link, and send
// through Cloudflare Email Service. Success is 200 with `{}` as application/json: Supabase rejects
// any other content type and rolls back the sign-up, which kills the link already sent (#87).

export interface HookDeps {
  // "v1,whsec_<base64>" as Supabase shows it.
  secret: string;
  appUrl: string;
  from: { email: string; name: string };
  send: (message: { to: string; from: { email: string; name: string } } & RenderedEmail) => Promise<unknown>;
}

interface HookPayload {
  user?: { email?: unknown };
  email_data?: { token_hash?: unknown; email_action_type?: unknown };
}

function hookError(status: number, message: string): Response {
  // Supabase reads { error: { http_code, message } } on failure.
  return Response.json({ error: { http_code: status, message } }, { status });
}

export async function handleSendEmailHook(body: string, headers: Headers, deps: HookDeps): Promise<Response> {
  let payload: HookPayload;
  try {
    const wh = new Webhook(deps.secret.replace(/^v1,/, ""));
    payload = wh.verify(body, {
      "webhook-id": headers.get("webhook-id") ?? "",
      "webhook-timestamp": headers.get("webhook-timestamp") ?? "",
      "webhook-signature": headers.get("webhook-signature") ?? "",
    }) as HookPayload;
  } catch {
    return hookError(401, "invalid signature");
  }

  const email = payload.user?.email;
  const tokenHash = payload.email_data?.token_hash;
  const type = payload.email_data?.email_action_type;
  if (typeof email !== "string" || typeof tokenHash !== "string" || typeof type !== "string") {
    return hookError(400, "malformed payload");
  }
  // Only sign-in emails exist today. Anything else fails loudly instead of sending a wrong email.
  if (!isSignInType(type)) return hookError(400, "unsupported email type");

  const rendered = renderSignInEmail(confirmUrl(deps.appUrl, tokenHash, type));
  try {
    await deps.send({ to: email, from: deps.from, ...rendered });
  } catch {
    return hookError(502, "email send failed");
  }
  return Response.json({}, { status: 200 });
}
