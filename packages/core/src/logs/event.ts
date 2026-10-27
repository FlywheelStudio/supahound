import type { EdgeField } from "../config/fields.js";

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
}

export type Role = "anon" | "authenticated" | "service_role" | "other" | "unknown";

// The user JWT's role wins; with no user JWT the API key decides.
export function effectiveRole(event: EdgeEvent): Role {
  const raw = event.jwtRole ?? event.apiKeyRole;
  if (raw === null) return "unknown";
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

// Rows come back from the rollup query with columns aliased to EdgeField names.
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
