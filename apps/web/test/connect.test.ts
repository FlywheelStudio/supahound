import { newState, sha256Hex, type Credentials } from "@guardbase/core/supabase/oauth";
import { tenantId, verifiedUserId } from "@guardbase/core/tenancy/scope";
import { describe, expect, it } from "vitest";
import { handleOAuthCallback, type CallbackDeps } from "../lib/connect";

const TENANT = tenantId("aaaaaaaa-0000-4000-8000-000000000001");
const USER = verifiedUserId("11111111-0000-4000-8000-000000000001");
const CREDS: Credentials = { accessToken: "at", refreshToken: "rt", expiresAt: null };

class NotAMember extends Error {}

// An in-memory stand-in for the oauth_states table: single-use, bound to user + tenant.
function fakeDeps(over: Partial<CallbackDeps> = {}) {
  const states = new Map<string, { user: string; tenant: string; verifier: string; used: boolean }>();
  const log: string[] = [];
  const stored: Credentials[] = [];
  const deps: CallbackDeps = {
    consume: async (user, tenant, hash) => {
      log.push("consume");
      if (user !== USER) throw new NotAMember();
      const s = states.get(hash);
      if (!s || s.used || s.user !== user || s.tenant !== tenant) return null;
      s.used = true;
      return s.verifier;
    },
    exchange: async () => { log.push("exchange"); return CREDS; },
    store: async (_u, _t, c) => { log.push("store"); stored.push(c); },
    isNotAMember: (err) => err instanceof NotAMember,
    ...over,
  };
  const start = () => {
    const state = newState(TENANT);
    states.set(sha256Hex(state), { user: USER, tenant: TENANT, verifier: "v".repeat(64), used: false });
    return state;
  };
  return { deps, log, stored, start };
}

const params = (o: Record<string, string>) => new URLSearchParams(o);

describe("Supabase OAuth callback", () => {
  it("consumes the state, then exchanges, then stores, and lands on the workspace", async () => {
    const { deps, log, stored, start } = fakeDeps();
    const state = start();
    expect(await handleOAuthCallback(params({ code: "c", state }), USER, deps)).toBe(`/w/${TENANT}?connected=1`);
    expect(log).toEqual(["consume", "exchange", "store"]);
    expect(stored).toEqual([CREDS]);
  });

  it("refuses a replay of the same callback URL", async () => {
    const { deps, stored, start } = fakeDeps();
    const state = start();
    await handleOAuthCallback(params({ code: "c", state }), USER, deps);
    expect(await handleOAuthCallback(params({ code: "c", state }), USER, deps)).toBe(`/w/${TENANT}?error=connect`);
    expect(stored).toHaveLength(1);
  });

  it("sends a signed-out visitor to sign in and touches nothing", async () => {
    const { deps, log, start } = fakeDeps();
    expect(await handleOAuthCallback(params({ code: "c", state: start() }), null, deps)).toBe("/login");
    expect(log).toEqual([]);
  });

  it.each([
    [{ code: "c", state: "garbage" }, "/app?error=connect"],
    [{ code: "c" }, "/app?error=connect"],
    [{ state: newState(TENANT), error: "access_denied" }, `/w/${TENANT}?error=consent`],
  ])("stores nothing for %j", async (p, expected) => {
    const { deps, log } = fakeDeps();
    expect(await handleOAuthCallback(params(p), USER, deps)).toBe(expected);
    expect(log).toEqual([]);
  });

  it("stores nothing for an unknown state", async () => {
    const { deps, log } = fakeDeps();
    expect(await handleOAuthCallback(params({ code: "c", state: newState(TENANT) }), USER, deps)).toBe(`/w/${TENANT}?error=connect`);
    expect(log).toEqual(["consume"]);
  });

  it("sends a non-member back to their workspaces", async () => {
    const { deps, log, start } = fakeDeps();
    const other = verifiedUserId("22222222-0000-4000-8000-000000000002");
    expect(await handleOAuthCallback(params({ code: "c", state: start() }), other, deps)).toBe("/app");
    expect(log).toEqual(["consume"]);
  });

  it("creates no connection when the exchange fails", async () => {
    const { deps, stored, start } = fakeDeps({ exchange: async () => { throw new Error("401"); } });
    expect(await handleOAuthCallback(params({ code: "c", state: start() }), USER, deps)).toBe(`/w/${TENANT}?error=connect`);
    expect(stored).toEqual([]);
  });
});
