// The only module that knows Supabase log field paths. Everything downstream reads the
// normalized EdgeEvent, so a path fix after the live check (PRD task 1) lands here alone.
//
// Sources:
//   verified  = listed in https://supabase.com/docs/guides/observability/log-field-reference
//               or the analytics/endpoints/logs changelog (fetched 2026-10-27)
//   unverified = inferred from Supabase troubleshooting queries; confirm with `discover-keys`
//   live       = seen by `discover-keys` on real projects (2026-11-22, issue #154): the key names
//               were counted, no values were read

export interface FieldPath {
  key: string;
  verified: boolean;
}

export const EDGE_FIELDS = {
  method: { key: "request.method", verified: true },
  path: { key: "request.path", verified: true },
  search: { key: "request.search", verified: true },
  status: { key: "response.status_code", verified: true },
  contentRange: { key: "response.headers.content_range", verified: true },
  userAgent: { key: "request.headers.user_agent", verified: true },
  clientInfo: { key: "request.headers.x_client_info", verified: true },
  asn: { key: "request.cf.asn", verified: true },
  asOrganization: { key: "request.cf.asOrganization", verified: true },
  jwtSubject: { key: "request.sb.jwt.authorization.payload.subject", verified: false },
  // Filled only for legacy JWT keys (live). sb_secret_ / sb_publishable_ keys are not JWTs, so
  // their requests carry no request.sb.jwt.* key at all: their role comes from the key kind below.
  jwtRole: { key: "request.sb.jwt.authorization.payload.role", verified: true },
  apiKeyRole: { key: "request.sb.jwt.apikey.payload.role", verified: true },
} as const satisfies Record<string, FieldPath>;

export type EdgeField = keyof typeof EDGE_FIELDS;

// The first 15 characters of the `apikey` header and of the Authorization header (live, on every
// request): `sb_secret_` or `sb_publishable_` plus key material, or `eyJ` for a JWT. They hold key
// material, so they are NEVER selected into Supahound: the SQL maps each one to a KeyKind inside
// ClickHouse (`keyKindSql` in logs/sql.ts) and only that enum leaves Supabase. That is why they
// live apart from EDGE_FIELDS, whose every path the rollup selects.
export const KEY_PREFIX_FIELDS = {
  apiKeyPrefix: { key: "request.sb.apikey.apikey.prefix", verified: true },
  authorizationPrefix: { key: "request.sb.apikey.authorization.prefix", verified: true },
} as const satisfies Record<string, FieldPath>;

export type KeyPrefixField = keyof typeof KEY_PREFIX_FIELDS;

// What kind of key a header held. `none`: the header was absent; `other`: something unrecognised.
export const KEY_KINDS = ["secret", "publishable", "jwt", "none", "other"] as const;
export type KeyKind = (typeof KEY_KINDS)[number];

// The marker each kind's prefix starts with, checked in order. Anything else non-empty is `other`.
export const KEY_KIND_MARKERS = [
  ["secret", "sb_secret_"],
  ["publishable", "sb_publishable_"],
  ["jwt", "eyJ"],
] as const satisfies readonly (readonly [KeyKind, string])[];

// The rollup's derived columns: each kind comes from one prefix field.
export const KEY_KIND_COLUMNS = {
  apiKeyKind: "apiKeyPrefix",
  authorizationKind: "authorizationPrefix",
} as const satisfies Record<string, KeyPrefixField>;

export type KeyKindColumn = keyof typeof KEY_KIND_COLUMNS;

// The API reference filters on `source`; the changelog filters on `source_name`.
// Env is passed in (Node: process.env; Workers: the env binding); core never reads globals.
export type EnvVars = Readonly<Record<string, string | undefined>>;

export function sourceColumn(env: EnvVars = {}): string {
  const column = env.SUPAHOUND_SOURCE_COLUMN ?? "source";
  if (column !== "source" && column !== "source_name") {
    throw new Error(`SUPAHOUND_SOURCE_COLUMN must be "source" or "source_name", got "${column}"`);
  }
  return column;
}

export function unverifiedFields(): (EdgeField | KeyPrefixField)[] {
  const all: Record<string, FieldPath> = { ...EDGE_FIELDS, ...KEY_PREFIX_FIELDS };
  return (Object.keys(all) as (EdgeField | KeyPrefixField)[]).filter((f) => !all[f]!.verified);
}
