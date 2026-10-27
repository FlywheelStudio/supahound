import { createHash } from "node:crypto";
import { describe, expect, it } from "vitest";
import {
  authorizeUrl, exchangeCode, needsRefresh, newState, OAuthError, parseCredentials, pkcePair, refreshCredentials, tenantFromState,
} from "../src/supabase/oauth.js";
import { tenantId } from "../src/tenancy/scope.js";

const TENANT = tenantId("aaaaaaaa-0000-4000-8000-000000000001");
const NOW = new Date("2026-10-27T12:00:00Z");
const client = (fetchImpl: typeof fetch) => ({ clientId: "cid", clientSecret: "secret", redirectUri: "https://app.example/api/supabase/callback", fetch: fetchImpl });

function capture(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

describe("PKCE and state", () => {
  it("derives the S256 challenge from the verifier", () => {
    const { verifier, challenge } = pkcePair();
    expect(verifier.length).toBeGreaterThanOrEqual(43);
    expect(challenge).toBe(createHash("sha256").update(verifier).digest("base64url"));
  });

  it("carries the tenant in the state and rejects malformed states", () => {
    const state = newState(TENANT);
    expect(tenantFromState(state)).toBe(TENANT);
    expect(newState(TENANT)).not.toBe(state);
    for (const bad of ["", "nope", `${TENANT}.short`, `not-a-uuid.${"x".repeat(43)}`]) expect(tenantFromState(bad)).toBeNull();
  });

  it("builds the authorize URL with PKCE and no deprecated scope parameter", () => {
    const u = new URL(authorizeUrl({ clientId: "cid", redirectUri: "https://app.example/cb" }, "st", "ch"));
    expect(Object.fromEntries(u.searchParams)).toEqual({
      client_id: "cid", redirect_uri: "https://app.example/cb", response_type: "code", state: "st",
      code_challenge: "ch", code_challenge_method: "S256",
    });
  });
});

describe("token requests", () => {
  it("exchanges a code with Basic auth, the verifier and the exact redirect URI", async () => {
    const { f, calls } = capture(200, { access_token: "at", refresh_token: "rt", expires_in: 3600, token_type: "Bearer" });
    const creds = await exchangeCode(client(f), "the-code", "the-verifier", NOW);
    expect(creds).toEqual({ accessToken: "at", refreshToken: "rt", expiresAt: "2026-10-27T13:00:00.000Z" });
    const init = calls[0]!.init;
    expect((init.headers as Record<string, string>).Authorization).toBe(`Basic ${Buffer.from("cid:secret").toString("base64")}`);
    expect(Object.fromEntries(new URLSearchParams(String(init.body)))).toEqual({
      grant_type: "authorization_code", code: "the-code", redirect_uri: "https://app.example/api/supabase/callback", code_verifier: "the-verifier",
    });
  });

  it("refreshes, keeping the old refresh token only when the server does not rotate it", async () => {
    const current = { accessToken: "old", refreshToken: "rt1", expiresAt: NOW.toISOString() };
    const rotated = capture(200, { access_token: "new", refresh_token: "rt2", expires_in: 60 });
    expect((await refreshCredentials(client(rotated.f), current, NOW)).refreshToken).toBe("rt2");
    expect(Object.fromEntries(new URLSearchParams(String(rotated.calls[0]!.init.body)))).toEqual({ grant_type: "refresh_token", refresh_token: "rt1" });
    const kept = capture(200, { access_token: "new", expires_in: 60 });
    expect((await refreshCredentials(client(kept.f), current, NOW)).refreshToken).toBe("rt1");
  });

  it("raises OAuthError with the status on failure or a missing token", async () => {
    await expect(exchangeCode(client(capture(401, {}).f), "c", "v")).rejects.toMatchObject({ name: "OAuthError", status: 401 });
    await expect(exchangeCode(client(capture(200, { token_type: "Bearer" }).f), "c", "v")).rejects.toThrow(OAuthError);
  });

  it("refreshes within five minutes of expiry, never without a refresh token", () => {
    const at = (min: number) => new Date(NOW.getTime() + min * 60_000).toISOString();
    expect(needsRefresh({ accessToken: "a", refreshToken: "r", expiresAt: at(10) }, NOW)).toBe(false);
    expect(needsRefresh({ accessToken: "a", refreshToken: "r", expiresAt: at(4) }, NOW)).toBe(true);
    expect(needsRefresh({ accessToken: "a", refreshToken: null, expiresAt: at(-1) }, NOW)).toBe(false);
  });

  it("reads stored credentials and treats a plain string as a static token", () => {
    expect(parseCredentials("sbp_static")).toEqual({ accessToken: "sbp_static", refreshToken: null, expiresAt: null });
    expect(parseCredentials(JSON.stringify({ accessToken: "a", refreshToken: "r", expiresAt: "x" }))).toEqual({ accessToken: "a", refreshToken: "r", expiresAt: "x" });
  });
});
