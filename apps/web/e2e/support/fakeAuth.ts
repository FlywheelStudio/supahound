import { createHash, generateKeyPairSync, randomBytes, randomUUID, sign, type KeyObject } from "node:crypto";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { Webhook } from "standardwebhooks";

// A stand-in for Supabase Auth (GoTrue) that implements only what the web app calls:
// magic-link send (/otp), token-hash verify (/verify), refresh, logout and the JWKS endpoint.
//
// Two parts of the real flow stay real:
// - getClaims() verifies our ES256 access tokens against /.well-known/jwks.json, exactly as it
//   does with Supabase's asymmetric signing keys (no shortcut through getUser()).
// - /otp calls the app's Send Email Hook with a Standard Webhooks signature, like Supabase does,
//   and records the hook's HTTP status so tests can assert the hook accepted it.
//
// Test-only control endpoints live under /__test/.

export interface SentLink {
  email: string;
  tokenHash: string;
  type: string;
  hookStatus: number;
}

interface User {
  id: string;
  email: string;
}

export interface FakeAuth {
  url: string;
  hookSecret: string;
  stop: () => Promise<void>;
}

function b64url(buf: Buffer | string): string {
  return Buffer.from(buf).toString("base64url");
}

async function body(req: IncomingMessage): Promise<Record<string, unknown>> {
  const chunks: Buffer[] = [];
  for await (const c of req) chunks.push(c as Buffer);
  const text = Buffer.concat(chunks).toString("utf8");
  return text ? (JSON.parse(text) as Record<string, unknown>) : {};
}

function json(res: ServerResponse, status: number, data: unknown): void {
  res.writeHead(status, { "content-type": "application/json" });
  res.end(JSON.stringify(data));
}

export async function startFakeAuth(port: number, appUrl: string): Promise<FakeAuth> {
  const { privateKey, publicKey } = generateKeyPairSync("ec", { namedCurve: "P-256" });
  const kid = randomUUID();
  const jwk = { ...publicKey.export({ format: "jwk" }), kid, alg: "ES256", use: "sig", key_ops: ["verify"] };
  const hookSecret = `v1,whsec_${randomBytes(32).toString("base64")}`;
  const webhook = new Webhook(hookSecret.replace(/^v1,/, ""));

  const usersByEmail = new Map<string, User>();
  const pending = new Map<string, User>(); // token hash → user, single use
  const refreshTokens = new Map<string, User>();
  const sent: SentLink[] = [];

  function accessToken(user: User, key: KeyObject): { token: string; exp: number } {
    const now = Math.floor(Date.now() / 1000);
    const exp = now + 3600;
    const header = b64url(JSON.stringify({ alg: "ES256", typ: "JWT", kid }));
    const payload = b64url(JSON.stringify({
      iss: `${url}/auth/v1`, aud: "authenticated", sub: user.id, email: user.email, role: "authenticated",
      aal: "aal1", session_id: randomUUID(), is_anonymous: false, iat: now, exp,
    }));
    const sig = sign("sha256", Buffer.from(`${header}.${payload}`), { key, dsaEncoding: "ieee-p1363" });
    return { token: `${header}.${payload}.${b64url(sig)}`, exp };
  }

  function session(user: User) {
    const { token, exp } = accessToken(user, privateKey);
    const refresh = randomBytes(16).toString("hex");
    refreshTokens.set(refresh, user);
    return {
      access_token: token, token_type: "bearer", expires_in: 3600, expires_at: exp, refresh_token: refresh,
      user: { id: user.id, aud: "authenticated", role: "authenticated", email: user.email, app_metadata: {}, user_metadata: {}, created_at: new Date().toISOString() },
    };
  }

  async function sendMagicLink(email: string): Promise<void> {
    let user = usersByEmail.get(email);
    if (!user) {
      user = { id: randomUUID(), email };
      usersByEmail.set(email, user);
    }
    const token = randomBytes(3).toString("hex");
    const tokenHash = createHash("sha224").update(`${email}${token}${randomUUID()}`).digest("hex");
    pending.set(tokenHash, user);
    const payload = JSON.stringify({
      user: { id: user.id, email },
      email_data: { token, token_hash: tokenHash, redirect_to: "https://evil.example/steal", email_action_type: "magiclink", site_url: appUrl },
    });
    const id = `msg_${randomUUID()}`;
    const ts = new Date();
    const res = await fetch(new URL("/api/auth/send-email-hook", appUrl), {
      method: "POST",
      headers: {
        "content-type": "application/json",
        "webhook-id": id,
        "webhook-timestamp": String(Math.floor(ts.getTime() / 1000)),
        "webhook-signature": webhook.sign(id, ts, payload),
      },
      body: payload,
    });
    sent.push({ email, tokenHash, type: "magiclink", hookStatus: res.status });
  }

  let url = "";
  const server: Server = createServer((req, res) => {
    void (async () => {
      const path = new URL(req.url ?? "/", "http://x").pathname;
      try {
        if (req.method === "GET" && path === "/auth/v1/.well-known/jwks.json") return json(res, 200, { keys: [jwk] });
        if (req.method === "POST" && path === "/auth/v1/otp") {
          const b = await body(req);
          await sendMagicLink(String(b.email).toLowerCase());
          return json(res, 200, {});
        }
        if (req.method === "POST" && path === "/auth/v1/verify") {
          const b = await body(req);
          const user = pending.get(String(b.token_hash));
          if (!user) return json(res, 403, { code: 403, error_code: "otp_expired", msg: "Token has expired or is invalid" });
          pending.delete(String(b.token_hash));
          return json(res, 200, session(user));
        }
        if (req.method === "POST" && path === "/auth/v1/token") {
          const b = await body(req);
          const user = refreshTokens.get(String(b.refresh_token));
          if (!user) return json(res, 400, { code: 400, error_code: "refresh_token_not_found", msg: "Invalid Refresh Token" });
          refreshTokens.delete(String(b.refresh_token));
          return json(res, 200, session(user));
        }
        if (req.method === "POST" && path === "/auth/v1/logout") {
          res.writeHead(204).end();
          return;
        }
        if (req.method === "GET" && path === "/__test/sent") return json(res, 200, sent);
        json(res, 404, { msg: `fake auth: no route for ${req.method} ${path}` });
      } catch (err) {
        json(res, 500, { msg: String(err) });
      }
    })();
  });

  await new Promise<void>((resolve) => server.listen(port, "127.0.0.1", resolve));
  url = `http://127.0.0.1:${port}`;
  return {
    url,
    hookSecret,
    stop: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}
