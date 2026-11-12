import { createHash, randomBytes } from "node:crypto";
import { tenantId, type TenantId } from "../tenancy/scope.js";

// Supabase OAuth for the Management API (decision 012).
// https://supabase.com/docs/guides/integrations/build-a-supabase-oauth-integration
// Scopes (analytics:read, database:read) are set on the OAuth app registration, not per request.

export const AUTHORIZE_URL = "https://api.supabase.com/v1/oauth/authorize";
export const TOKEN_URL = "https://api.supabase.com/v1/oauth/token";
export const STATE_TTL_SECONDS = 600;
// Refresh this long before expiry so a poll never starts with a token about to lapse.
export const REFRESH_MARGIN_SECONDS = 300;

export interface OAuthClient {
  clientId: string;
  clientSecret: string;
  redirectUri: string;
  fetch?: typeof fetch;
}

// What a connection stores, sealed. A plain string from older rows is a static token.
export interface Credentials {
  accessToken: string;
  refreshToken: string | null;
  expiresAt: string | null;
}

export class OAuthError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "OAuthError";
  }
}

const b64url = (b: Buffer) => b.toString("base64url");
export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

export function pkcePair(): { verifier: string; challenge: string } {
  const verifier = b64url(randomBytes(48)); // 64 chars, inside RFC 7636's 43–128
  return { verifier, challenge: b64url(createHash("sha256").update(verifier).digest()) };
}

// "<tenant uuid>.<32 random bytes>". The tenant part only routes the callback to the right
// tenant transaction; the stored hash, user binding and expiry are what authorize it.
export function newState(tenant: TenantId): string {
  return `${tenant}.${b64url(randomBytes(32))}`;
}

export function tenantFromState(state: string): TenantId | null {
  const [t, nonce] = state.split(".");
  if (!t || !nonce || nonce.length < 43) return null;
  try {
    return tenantId(t);
  } catch {
    return null;
  }
}

export function authorizeUrl(client: Pick<OAuthClient, "clientId" | "redirectUri">, state: string, challenge: string): string {
  const url = new URL(AUTHORIZE_URL);
  url.searchParams.set("client_id", client.clientId);
  url.searchParams.set("redirect_uri", client.redirectUri);
  url.searchParams.set("response_type", "code");
  url.searchParams.set("state", state);
  url.searchParams.set("code_challenge", challenge);
  url.searchParams.set("code_challenge_method", "S256");
  return url.toString();
}

async function tokenRequest(client: OAuthClient, body: Record<string, string>, now: Date): Promise<Credentials> {
  const res = await (client.fetch ?? fetch)(TOKEN_URL, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-www-form-urlencoded",
      Accept: "application/json",
      Authorization: `Basic ${Buffer.from(`${client.clientId}:${client.clientSecret}`).toString("base64")}`,
    },
    body: new URLSearchParams(body).toString(),
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new OAuthError(`Token endpoint returned HTTP ${res.status}`, res.status);
  const j = (await res.json()) as { access_token?: unknown; refresh_token?: unknown; expires_in?: unknown };
  if (typeof j.access_token !== "string" || j.access_token === "") throw new OAuthError("No access token in response", res.status);
  const expiresIn = typeof j.expires_in === "number" && j.expires_in > 0 ? j.expires_in : null;
  return {
    accessToken: j.access_token,
    refreshToken: typeof j.refresh_token === "string" && j.refresh_token !== "" ? j.refresh_token : null,
    expiresAt: expiresIn ? new Date(now.getTime() + expiresIn * 1000).toISOString() : null,
  };
}

export function exchangeCode(client: OAuthClient, code: string, verifier: string, now = new Date()): Promise<Credentials> {
  return tokenRequest(client, { grant_type: "authorization_code", code, redirect_uri: client.redirectUri, code_verifier: verifier }, now);
}

export async function refreshCredentials(client: OAuthClient, current: Credentials, now = new Date()): Promise<Credentials> {
  if (!current.refreshToken) throw new OAuthError("No refresh token", 401);
  const next = await tokenRequest(client, { grant_type: "refresh_token", refresh_token: current.refreshToken }, now);
  // Keep the old refresh token only if the server did not rotate it.
  return { ...next, refreshToken: next.refreshToken ?? current.refreshToken };
}

export function needsRefresh(c: Credentials, now: Date): boolean {
  if (!c.expiresAt || !c.refreshToken) return false;
  return Date.parse(c.expiresAt) - now.getTime() <= REFRESH_MARGIN_SECONDS * 1000;
}

export function parseCredentials(stored: string): Credentials {
  if (stored.startsWith("{")) {
    const c = JSON.parse(stored) as Partial<Credentials>;
    if (typeof c.accessToken !== "string") throw new Error("Stored credentials have no access token");
    return { accessToken: c.accessToken, refreshToken: c.refreshToken ?? null, expiresAt: c.expiresAt ?? null };
  }
  return { accessToken: stored, refreshToken: null, expiresAt: null };
}

// Ends the grant at Supabase (disconnect, decision 037): POST /v1/oauth/revoke with the app's
// credentials and the refresh token. Supabase marks this endpoint Beta, so the caller treats it as
// best effort: false on any failure, never a throw. The local token is deleted either way.
export async function revokeGrant(client: OAuthClient, refreshToken: string, baseUrl = "https://api.supabase.com"): Promise<boolean> {
  try {
    const res = await (client.fetch ?? fetch)(new URL("/v1/oauth/revoke", baseUrl).toString(), {
      method: "POST",
      headers: { "Content-Type": "application/json", Accept: "application/json" },
      body: JSON.stringify({ client_id: client.clientId, client_secret: client.clientSecret, refresh_token: refreshToken }),
      signal: AbortSignal.timeout(10_000),
    });
    return res.ok;
  } catch {
    return false;
  }
}
