import { env } from "cloudflare:workers";
import { handleSendEmailHook } from "../../../../lib/email/hook";

// Called by Supabase Auth, not by browsers. Verified by signature (lib/email/hook.ts).
export async function POST(request: Request) {
  return handleSendEmailHook(await request.text(), request.headers, {
    secret: env.SEND_EMAIL_HOOK_SECRET,
    appUrl: env.APP_URL,
    from: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME },
    send: (m) => env.EMAIL.send(m),
  });
}
