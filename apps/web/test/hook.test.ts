import { randomBytes } from "node:crypto";
import { Webhook } from "standardwebhooks";
import { describe, expect, it } from "vitest";
import { handleSendEmailHook, type HookDeps } from "../lib/email/hook";

const SECRET = `v1,whsec_${randomBytes(32).toString("base64")}`;
const APP = "https://app.supahound.example";

function signed(payload: unknown, secret = SECRET, at = new Date()): { body: string; headers: Headers } {
  const body = JSON.stringify(payload);
  const id = `msg_${randomBytes(6).toString("hex")}`;
  const signature = new Webhook(secret.replace(/^v1,/, "")).sign(id, at, body);
  return {
    body,
    headers: new Headers({
      "webhook-id": id,
      "webhook-timestamp": String(Math.floor(at.getTime() / 1000)),
      "webhook-signature": signature,
    }),
  };
}

const payload = (type = "magiclink", over: Record<string, unknown> = {}) => ({
  user: { id: "u1", email: "dev@example.com" },
  email_data: { token: "123456", token_hash: "abc123hash", redirect_to: "https://evil.example/steal", email_action_type: type, site_url: "x", ...over },
});

function deps(sent: unknown[] = []): HookDeps {
  return {
    secret: SECRET, appUrl: APP, from: { email: "login@supahound.example", name: "Supahound" },
    send: async (m) => { sent.push(m); return { messageId: "m1" }; },
  };
}

describe("Send Email Hook", () => {
  it("sends a sign-in email whose link points at our confirm route, never redirect_to", async () => {
    const sent: { to: string; text: string; html: string; subject: string }[] = [];
    const { body, headers } = signed(payload());
    const res = await handleSendEmailHook(body, headers, deps(sent as unknown[]));
    expect(res.status).toBe(200);
    // Supabase needs a JSON body on success, or it rolls back the sign-up (#87).
    expect(res.headers.get("content-type")).toMatch(/^application\/json/);
    expect(await res.json()).toEqual({});
    expect(sent).toHaveLength(1);
    expect(sent[0]!.to).toBe("dev@example.com");
    expect(sent[0]!.text).toContain(`${APP}/auth/confirm?token_hash=abc123hash&type=magiclink`);
    expect(sent[0]!.text).not.toContain("evil.example");
    expect(sent[0]!.html).not.toContain("evil.example");
  });

  it.each(["signup", "email"])("handles first-time %s emails the same way", async (type) => {
    const sent: { text: string }[] = [];
    const { body, headers } = signed(payload(type));
    expect((await handleSendEmailHook(body, headers, deps(sent as unknown[]))).status).toBe(200);
    expect(sent[0]!.text).toContain(`type=${type}`);
  });

  it("rejects a wrong secret, a tampered body, missing headers and an old timestamp", async () => {
    const wrong = signed(payload(), `v1,whsec_${randomBytes(32).toString("base64")}`);
    const good = signed(payload());
    const old = signed(payload(), SECRET, new Date(Date.now() - 60 * 60 * 1000));
    const sent: unknown[] = [];
    for (const [body, headers] of [
      [wrong.body, wrong.headers],
      [good.body.replace("dev@example.com", "attacker@example.com"), good.headers],
      [good.body, new Headers()],
      [old.body, old.headers],
    ] as const) {
      expect((await handleSendEmailHook(body, headers, deps(sent))).status).toBe(401);
    }
    expect(sent).toEqual([]);
  });

  it("refuses email types it does not handle instead of sending a wrong email", async () => {
    const sent: unknown[] = [];
    const { body, headers } = signed(payload("email_change"));
    const res = await handleSendEmailHook(body, headers, deps(sent));
    expect(res.status).toBe(400);
    expect(await res.json()).toEqual({ error: { http_code: 400, message: "unsupported email type" } });
    expect(sent).toEqual([]);
  });

  it("reports a send failure so Supabase does not think the email went out", async () => {
    const { body, headers } = signed(payload());
    const res = await handleSendEmailHook(body, headers, { ...deps(), send: async () => { throw Object.assign(new Error("x"), { code: "E_SENDER_NOT_VERIFIED" }); } });
    expect(res.status).toBe(502);
  });

  it("escapes the link in HTML", async () => {
    const sent: { html: string }[] = [];
    const { body, headers } = signed(payload("magiclink", { token_hash: '"><script>alert(1)</script>' }));
    await handleSendEmailHook(body, headers, deps(sent as unknown[]));
    expect(sent[0]!.html).not.toContain("<script>");
  });
});
