import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as repo from "../../src/db/repo.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import { accessTokenFor } from "../../src/supabase/credentials.js";
import { newState, OAuthError, sha256Hex } from "../../src/supabase/oauth.js";
import { verifiedUserId, type ConnectionId, type TenantId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

const NOW = new Date("2026-10-27T12:00:00Z");

describe.skipIf(pgInfo === null)("Supabase OAuth connect", () => {
  const db = useDb();
  const owner = verifiedUserId(randomUUID());
  const attacker = verifiedUserId(randomUUID());
  let victim: TenantId;
  let attackerTenant: TenantId;

  beforeAll(async () => {
    victim = await createWorkspace(db.app, owner, "Victim Co");
    attackerTenant = await createWorkspace(db.app, attacker, "Attacker Co");
  });

  async function startFlow(user = owner, tenant = victim, expiresAt = new Date(NOW.getTime() + 600_000)) {
    const state = newState(tenant);
    await withTenantForUser(db.app, user, tenant, (tx) =>
      repo.createOAuthState(tx, { userId: user, stateHash: sha256Hex(state), codeVerifier: "v".repeat(64), expiresAt }),
    );
    return state;
  }

  const consume = (user: typeof owner, tenant: TenantId, state: string) =>
    withTenantForUser(db.app, user, tenant, (tx) => repo.consumeOAuthState(tx, user, sha256Hex(state), NOW));

  it("consumes a state exactly once", async () => {
    const state = await startFlow();
    expect(await consume(owner, victim, state)).toBe("v".repeat(64));
    expect(await consume(owner, victim, state)).toBeNull();
  });

  it("rejects a state started by another user, for another tenant, or expired", async () => {
    // The attacker starts a flow in their own tenant and tricks the victim into the callback:
    // the victim's session cannot consume it (wrong user), and it never touches the victim's tenant.
    const attackerState = await startFlow(attacker, attackerTenant);
    await expect(consume(owner, attackerTenant, attackerState)).rejects.toThrow(/Not a member/);
    expect(await consume(owner, victim, attackerState)).toBeNull();
    // The victim's own state cannot be replayed through the attacker's session.
    const victimState = await startFlow();
    await expect(consume(attacker, victim, victimState)).rejects.toThrow(/Not a member/);
    expect(await consume(attacker, attackerTenant, victimState)).toBeNull();
    // Another member of the same workspace cannot finish the owner's flow either.
    const colleague = verifiedUserId(randomUUID());
    await withTenantForUser(db.app, owner, victim, (tx) =>
      tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [victim, colleague]),
    );
    const ownersState = await startFlow();
    expect(await consume(colleague, victim, ownersState)).toBeNull();
    expect(await consume(owner, victim, ownersState)).toBe("v".repeat(64));
    // Expired.
    const old = await startFlow(owner, victim, new Date(NOW.getTime() - 1000));
    expect(await consume(owner, victim, old)).toBeNull();
  });

  describe("token refresh", () => {
    let connection: ConnectionId;
    const soon = new Date(NOW.getTime() + 60_000).toISOString();

    beforeAll(async () => {
      connection = await withTenantForUser(db.app, owner, victim, (tx) =>
        repo.createConnection(tx, db.vault, { label: "org", token: JSON.stringify({ accessToken: "at1", refreshToken: "rt1", expiresAt: soon }) }),
      );
    });

    it("refreshes once even when two pollers ask at the same time, and both get the new token", async () => {
      let calls = 0;
      const f = (async () => {
        calls++;
        await new Promise((r) => setTimeout(r, 100));
        return new Response(JSON.stringify({ access_token: `at${calls + 1}`, refresh_token: `rt${calls + 1}`, expires_in: 3600 }), { status: 200 });
      }) as unknown as typeof fetch;
      const oauth = { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb", fetch: f };
      const tokens = await Promise.all([
        accessTokenFor(db.app, db.vault, victim, connection, oauth, NOW),
        accessTokenFor(db.app, db.vault, victim, connection, oauth, NOW),
      ]);
      expect(calls).toBe(1);
      expect(tokens).toEqual(["at2", "at2"]);
      // Fresh now: no further refresh.
      expect(await accessTokenFor(db.app, db.vault, victim, connection, oauth, NOW)).toBe("at2");
      expect(calls).toBe(1);
    });

    it("leaves stored credentials untouched when a refresh fails", async () => {
      const conn = await withTenantForUser(db.app, owner, victim, (tx) =>
        repo.createConnection(tx, db.vault, { label: "org2", token: JSON.stringify({ accessToken: "keep", refreshToken: "rt", expiresAt: soon }) }),
      );
      const failing = { clientId: "c", clientSecret: "s", redirectUri: "https://x/cb", fetch: (async () => new Response("{}", { status: 401 })) as unknown as typeof fetch };
      await expect(accessTokenFor(db.app, db.vault, victim, conn, failing, NOW)).rejects.toThrow(OAuthError);
      expect(await accessTokenFor(db.app, db.vault, victim, conn, null, NOW)).toBe("keep");
    });

    it("cannot read another tenant's connection", async () => {
      await expect(accessTokenFor(db.app, db.vault, attackerTenant, connection, null, NOW)).rejects.toThrow(/not found/);
    });
  });
});
