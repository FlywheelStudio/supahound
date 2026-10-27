import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { connectionId, tenantId } from "../src/tenancy/scope.js";
import { TokenVault, VaultError } from "../src/vault/vault.js";

const TENANT_A = tenantId("aaaaaaaa-0000-4000-8000-000000000001");
const TENANT_B = tenantId("bbbbbbbb-0000-4000-8000-000000000002");
const CONN_1 = connectionId("c0000000-0000-4000-8000-000000000001");
const CONN_2 = connectionId("c0000000-0000-4000-8000-000000000002");
const TOKEN = "sbp_oauth_synthetic_token_for_tests";

const vault = (keys: Record<number, Buffer>) => new TokenVault(new Map(Object.entries(keys).map(([v, k]) => [Number(v), k])));
const key1 = randomBytes(32);
const key2 = randomBytes(32);

describe("TokenVault", () => {
  const v = vault({ 1: key1 });

  it("round-trips a token for its own tenant and connection", () => {
    const sealed = v.seal(TOKEN, { tenantId: TENANT_A, connectionId: CONN_1 });
    expect(sealed.includes(Buffer.from(TOKEN))).toBe(false);
    expect(v.open(sealed, { tenantId: TENANT_A, connectionId: CONN_1 })).toBe(TOKEN);
  });

  it("refuses to open a token under another tenant", () => {
    const sealed = v.seal(TOKEN, { tenantId: TENANT_A, connectionId: CONN_1 });
    expect(() => v.open(sealed, { tenantId: TENANT_B, connectionId: CONN_1 })).toThrow(VaultError);
  });

  it("refuses to open a token under another connection of the same tenant", () => {
    const sealed = v.seal(TOKEN, { tenantId: TENANT_A, connectionId: CONN_1 });
    expect(() => v.open(sealed, { tenantId: TENANT_A, connectionId: CONN_2 })).toThrow(VaultError);
  });

  it("detects tampering with the ciphertext, tag or key version", () => {
    const binding = { tenantId: TENANT_A, connectionId: CONN_1 };
    const sealed = v.seal(TOKEN, binding);
    for (const offset of [sealed.length - 1, 20]) {
      const bad = Buffer.from(sealed);
      bad[offset] = bad[offset]! ^ 0xff;
      expect(() => v.open(bad, binding)).toThrow(VaultError);
    }
    const relabeled = Buffer.from(sealed);
    relabeled.writeUInt16BE(2, 1);
    expect(() => vault({ 1: key1, 2: key1 }).open(relabeled, binding)).toThrow(VaultError);
  });

  it("uses a fresh IV every time", () => {
    const binding = { tenantId: TENANT_A, connectionId: CONN_1 };
    expect(v.seal(TOKEN, binding).equals(v.seal(TOKEN, binding))).toBe(false);
  });

  it("seals with the newest key and still opens older versions", () => {
    const old = v.seal(TOKEN, { tenantId: TENANT_A, connectionId: CONN_1 });
    const rotated = vault({ 1: key1, 2: key2 });
    const fresh = rotated.seal(TOKEN, { tenantId: TENANT_A, connectionId: CONN_1 });
    expect(rotated.keyVersionOf(fresh)).toBe(2);
    expect(rotated.open(old, { tenantId: TENANT_A, connectionId: CONN_1 })).toBe(TOKEN);
  });

  it("rejects bad configuration", () => {
    expect(() => vault({})).toThrow(/No master keys/);
    expect(() => vault({ 1: randomBytes(16) })).toThrow(/32 bytes/);
    expect(() => TokenVault.fromEnv({})).toThrow(/GUARDBASE_MASTER_KEYS/);
    const fromEnv = TokenVault.fromEnv({ GUARDBASE_MASTER_KEYS: `1:${key1.toString("base64")}` });
    expect(fromEnv.currentVersion).toBe(1);
  });
});
