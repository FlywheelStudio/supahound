import { KEY_KINDS, type EdgeField, type KeyKind, type KeyKindColumn } from "../config/fields.js";

// One edge-log request template, after the SQL rollup. `hits` counts identical requests
// in the window, so detectors see each distinct request shape once.
export interface EdgeEvent {
  firstSeen: string;
  lastSeen: string;
  hits: number;
  method: string;
  path: string;
  search: string;
  status: number | null;
  contentRange: string | null;
  userAgent: string | null;
  clientInfo: string | null;
  asn: number | null;
  asOrganization: string | null;
  jwtSubject: string | null;
  jwtRole: string | null;
  apiKeyRole: string | null;
  // The kind of key in the apikey and Authorization headers, worked out in the SQL (#154). Never
  // the key or its prefix. Null when the row did not say (an older rollup, a fixture).
  apiKeyKind: KeyKind | null;
  authorizationKind: KeyKind | null;
}

export type Role = "anon" | "authenticated" | "service_role" | "other" | "unknown";

// The role a new (non-JWT) API key stands for (#154). A JWT key's role is in its payload instead.
const KEY_KIND_ROLE: Partial<Record<KeyKind, Role>> = { secret: "service_role", publishable: "anon" };

// The user JWT's role wins; with no user JWT the legacy API key's role decides, and with neither
// the new key's kind: sb_secret_ is service_role, sb_publishable_ is anon.
export function effectiveRole(event: EdgeEvent): Role {
  const raw = event.jwtRole ?? event.apiKeyRole;
  if (raw === null) return (event.apiKeyKind === null ? undefined : KEY_KIND_ROLE[event.apiKeyKind]) ?? "unknown";
  if (raw === "anon" || raw === "authenticated" || raw === "service_role") return raw;
  return "other";
}

type Row = Record<string, unknown>;

function str(row: Row, key: EdgeField): string | null {
  const v = row[key];
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s === "" ? null : s;
}

function num(row: Row, key: EdgeField): number | null {
  const s = str(row, key);
  if (s === null) return null;
  const n = Number(s);
  return Number.isFinite(n) ? n : null;
}

// A key-kind column: one of the known enums, or null. Anything else is dropped, not passed on.
function kind(row: Row, key: KeyKindColumn): KeyKind | null {
  const v = row[key];
  return typeof v === "string" && (KEY_KINDS as readonly string[]).includes(v) ? (v as KeyKind) : null;
}

// Rows come back from the rollup query with columns aliased to EdgeField names (and the key kinds).
export function normalizeRow(row: Row): EdgeEvent {
  const hits = Number(row.hits ?? 1);
  return {
    firstSeen: String(row.first_seen ?? ""),
    lastSeen: String(row.last_seen ?? row.first_seen ?? ""),
    hits: Number.isFinite(hits) && hits > 0 ? hits : 1,
    method: (str(row, "method") ?? "GET").toUpperCase(),
    path: str(row, "path") ?? "",
    search: str(row, "search") ?? "",
    status: num(row, "status"),
    contentRange: str(row, "contentRange"),
    userAgent: str(row, "userAgent"),
    clientInfo: str(row, "clientInfo"),
    asn: num(row, "asn"),
    asOrganization: str(row, "asOrganization"),
    jwtSubject: str(row, "jwtSubject"),
    jwtRole: str(row, "jwtRole"),
    apiKeyRole: str(row, "apiKeyRole"),
    apiKeyKind: kind(row, "apiKeyKind"),
    authorizationKind: kind(row, "authorizationKind"),
  };
}

// PostgREST Content-Range: "0-24/*", "0-24/3573", "*/0", "*/*". Null when absent or unparseable.
export function rowsReturned(contentRange: string | null): number | null {
  if (contentRange === null) return null;
  const m = /^\s*(\*|(\d+)-(\d+))\s*\/\s*(\*|\d+)\s*$/.exec(contentRange);
  if (!m) return null;
  if (m[1] === "*") return 0;
  return Number(m[3]) - Number(m[2]) + 1;
}
