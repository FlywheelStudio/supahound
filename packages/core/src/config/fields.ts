// The only module that knows Supabase log field paths. Everything downstream reads the
// normalized EdgeEvent, so a path fix after the live check (PRD task 1) lands here alone.
//
// Sources:
//   verified  = listed in https://supabase.com/docs/guides/observability/log-field-reference
//               or the analytics/endpoints/logs changelog (fetched 2026-10-27)
//   unverified = inferred from Supabase troubleshooting queries; confirm with `discover-keys`

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
  jwtRole: { key: "request.sb.jwt.authorization.payload.role", verified: false },
  apiKeyRole: { key: "request.sb.jwt.apikey.payload.role", verified: false },
} as const satisfies Record<string, FieldPath>;

export type EdgeField = keyof typeof EDGE_FIELDS;

// The API reference filters on `source`; the changelog filters on `source_name`.
// Env is passed in (Node: process.env; Workers: the env binding); core never reads globals.
export type EnvVars = Readonly<Record<string, string | undefined>>;

export function sourceColumn(env: EnvVars = {}): string {
  const column = env.GUARDBASE_SOURCE_COLUMN ?? "source";
  if (column !== "source" && column !== "source_name") {
    throw new Error(`GUARDBASE_SOURCE_COLUMN must be "source" or "source_name", got "${column}"`);
  }
  return column;
}

export function unverifiedFields(): EdgeField[] {
  return (Object.keys(EDGE_FIELDS) as EdgeField[]).filter((f) => !EDGE_FIELDS[f].verified);
}
