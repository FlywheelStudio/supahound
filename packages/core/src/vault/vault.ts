import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from "node:crypto";
import type { EnvVars } from "../config/fields.js";
import type { ConnectionId, TenantId } from "../tenancy/scope.js";

// Seals Supabase OAuth tokens at rest (PRD, Credential hygiene).
//
//   * AES-256-GCM with a fresh 96-bit IV per seal.
//   * The key is derived per tenant from a versioned master key (HKDF-SHA256, salt = tenant ID),
//     so no two tenants share a data key.
//   * The associated data binds tenant + connection + key version. A sealed token copied into
//     another tenant's row, or another connection's row, fails authentication instead of
//     decrypting.
//
// Layout: [format 0x01][key version u16 BE][iv 12][tag 16][ciphertext]

const FORMAT = 0x01;
const IV_BYTES = 12;
const TAG_BYTES = 16;
const HEADER_BYTES = 1 + 2 + IV_BYTES + TAG_BYTES;
const INFO = Buffer.from("supahound/connection-token/v1");

export class VaultError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "VaultError";
  }
}

export interface TokenBinding {
  tenantId: TenantId;
  connectionId: ConnectionId;
}

// A new SUPAHOUND_MASTER_KEYS value (self-hosting, decision 025). With no current value it
// returns "1:<key>". With one, it keeps every old key (sealed tokens still open) and appends the
// next version, which then seals new tokens. Each key is 32 random bytes, base64.
export function newMasterKeys(current?: string): string {
  const key = randomBytes(32).toString("base64");
  if (!current?.trim()) return `1:${key}`;
  const vault = TokenVault.fromEnv({ SUPAHOUND_MASTER_KEYS: current });
  return `${current.trim()},${vault.currentVersion + 1}:${key}`;
}

export class TokenVault {
  private readonly keys: ReadonlyMap<number, Buffer>;
  readonly currentVersion: number;

  constructor(masterKeys: ReadonlyMap<number, Buffer>) {
    if (masterKeys.size === 0) throw new VaultError("No master keys configured");
    for (const [version, key] of masterKeys) {
      if (!Number.isInteger(version) || version < 1 || version > 0xffff) throw new VaultError("Bad key version");
      if (key.length !== 32) throw new VaultError("Master keys must be 32 bytes");
    }
    this.keys = masterKeys;
    this.currentVersion = Math.max(...masterKeys.keys());
  }

  // SUPAHOUND_MASTER_KEYS="1:<base64 32 bytes>,2:<base64 32 bytes>". The highest version seals.
  static fromEnv(env: EnvVars): TokenVault {
    const raw = env.SUPAHOUND_MASTER_KEYS;
    if (!raw) throw new VaultError("SUPAHOUND_MASTER_KEYS is not set");
    const keys = new Map<number, Buffer>();
    for (const part of raw.split(",")) {
      const [v, b64] = part.trim().split(":");
      keys.set(Number(v), Buffer.from(b64 ?? "", "base64"));
    }
    return new TokenVault(keys);
  }

  private tenantKey(version: number, tenantId: TenantId): Buffer {
    const master = this.keys.get(version);
    if (!master) throw new VaultError(`Unknown key version ${version}`);
    return Buffer.from(hkdfSync("sha256", master, Buffer.from(tenantId), INFO, 32));
  }

  private static aad(binding: TokenBinding, version: number): Buffer {
    return Buffer.from(`supahound:connection-token:${binding.tenantId}:${binding.connectionId}:${version}`);
  }

  seal(plaintext: string, binding: TokenBinding): Buffer {
    const version = this.currentVersion;
    const iv = randomBytes(IV_BYTES);
    const cipher = createCipheriv("aes-256-gcm", this.tenantKey(version, binding.tenantId), iv);
    cipher.setAAD(TokenVault.aad(binding, version));
    const body = Buffer.concat([cipher.update(plaintext, "utf8"), cipher.final()]);
    const header = Buffer.alloc(3);
    header.writeUInt8(FORMAT, 0);
    header.writeUInt16BE(version, 1);
    return Buffer.concat([header, iv, cipher.getAuthTag(), body]);
  }

  open(sealed: Buffer, binding: TokenBinding): string {
    if (sealed.length < HEADER_BYTES || sealed.readUInt8(0) !== FORMAT) throw new VaultError("Not a sealed token");
    const version = sealed.readUInt16BE(1);
    const iv = sealed.subarray(3, 3 + IV_BYTES);
    const tag = sealed.subarray(3 + IV_BYTES, HEADER_BYTES);
    const decipher = createDecipheriv("aes-256-gcm", this.tenantKey(version, binding.tenantId), iv);
    decipher.setAAD(TokenVault.aad(binding, version));
    decipher.setAuthTag(tag);
    try {
      return Buffer.concat([decipher.update(sealed.subarray(HEADER_BYTES)), decipher.final()]).toString("utf8");
    } catch {
      // Same message for every failure: wrong tenant, wrong connection, tampering.
      throw new VaultError("Token does not belong to this tenant and connection, or was altered");
    }
  }

  keyVersionOf(sealed: Buffer): number {
    return sealed.readUInt16BE(1);
  }
}
