import {
  ADVISOR_FIELDS as F, ADVISOR_LEVELS, ADVISOR_LINT_OBJECT_TYPE, ADVISOR_METADATA as M, ADVISOR_OBJECT_TYPES, ADVISOR_PATH,
  ADVISOR_SECURITY_CATEGORY, ADVISOR_UNAVAILABLE_LINT, LINT_NAME_RE, MAX_ADVISOR_LINTS, type AdvisorLevel,
} from "../config/posture.js";
import type { Severity } from "../detectors/finding.js";
import { MANAGEMENT_API } from "../logs/client.js";
import { QUERY_TIMEOUT_MS } from "../ownership/client.js";
import { safeName } from "./catalog.js";
import type { PostureEvidenceValue, PostureFinding } from "./types.js";

// Supabase Security Advisor (issue #11, decision 038): GET /v1/projects/{ref}/advisors/security.
// Experimental in the Management API reference; scope database:read. A failure of any kind is
// "unable to assess" for this source, never zero findings.
//
// Only structured fields leave this module: the lint name (a snake_case enum), its level, the
// object type (an enum) and the object's schema and name (catalog identifiers). The free text
// fields (title, description, detail, remediation) are never read. The newer splinter lints add
// a few structured metadata keys (ADVISOR_METADATA, issue #134); each is kept as evidence only
// when it passes the check for a catalog name, an enum, a boolean or a version.

export class AdvisorApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "AdvisorApiError";
  }
}

export interface AdvisorLint {
  name: string;
  level: AdvisorLevel;
  security: boolean;
  schema: string | null;
  object: string | null;
  type: string | null;
  // Checked metadata of the newer lints: policy, command, policies, arguments, securityDefiner,
  // sensitiveColumns, foreignKey, extension, installedVersion, defaultVersion. Empty for most lints.
  evidence: Record<string, PostureEvidenceValue>;
}

export interface AdvisorClientOptions {
  token: string;
  fetch?: typeof fetch;
  baseUrl?: string;
  timeoutMs?: number;
}

export async function querySecurityAdvisor(projectRef: string, options: AdvisorClientOptions): Promise<AdvisorLint[]> {
  if (!/^[a-z0-9]{20}$/.test(projectRef)) throw new Error(`Not a Supabase project ref: "${projectRef}"`);
  const doFetch = options.fetch ?? fetch;
  const url = new URL(ADVISOR_PATH(projectRef), options.baseUrl ?? MANAGEMENT_API);
  const res = await doFetch(url, {
    method: "GET",
    headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(options.timeoutMs ?? QUERY_TIMEOUT_MS),
  });
  // The error body never leaves this function: only the status.
  if (!res.ok) throw new AdvisorApiError(`Security Advisor returned HTTP ${res.status}`, res.status);
  let body: unknown;
  try {
    body = await res.json();
  } catch {
    throw new AdvisorApiError("Security Advisor response is not JSON", res.status);
  }
  const list = body !== null && typeof body === "object" ? (body as Record<string, unknown>)[F.lints] : undefined;
  const lints = Array.isArray(list) ? list : null;
  if (lints === null) throw new AdvisorApiError("Security Advisor response has no lints array", res.status);
  if (lints.length > MAX_ADVISOR_LINTS) throw new AdvisorApiError(`More than ${MAX_ADVISOR_LINTS} lints`, res.status);
  return parseLints(lints);
}

// A function's identity arguments ("uid uuid, query text"): at most 512 characters and no
// control characters, so they can sit on one SQL line of a fix prompt.
export function safeArguments(v: unknown): string | null {
  // eslint-disable-next-line no-control-regex
  return typeof v === "string" && v.length <= 512 && !/[\u0000-\u001f\u007f]/.test(v) ? v : null;
}

const VERSION_RE = /^[0-9A-Za-z._+-]{1,32}$/;
const POLICY_COMMANDS: readonly unknown[] = ["SELECT", "INSERT", "UPDATE", "DELETE", "ALL"];
const MAX_LISTED = 50;

function metadataEvidence(meta: Record<string, unknown>): Record<string, PostureEvidenceValue> {
  const out: Record<string, PostureEvidenceValue> = {};
  const name = (key: string, v: unknown) => {
    const s = safeName(v);
    if (s !== null) out[key] = s;
  };
  const names = (key: string, v: unknown) => {
    if (!Array.isArray(v)) return;
    const list = v.map(safeName).filter((x): x is string => x !== null).slice(0, MAX_LISTED);
    if (list.length > 0) out[key] = list;
  };
  name("policy", meta[M.policy]);
  if (POLICY_COMMANDS.includes(meta[M.command])) out.command = meta[M.command] as string;
  names("policies", meta[M.policies]);
  const args = safeArguments(meta[M.arguments]);
  if (args !== null) out.arguments = args;
  const definer = meta[M.securityDefiner];
  if (typeof definer === "boolean") out.securityDefiner = definer;
  names("sensitiveColumns", meta[M.sensitiveColumns]);
  name("foreignKey", meta[M.foreignKey]);
  name("extension", meta[M.extension]);
  for (const key of ["installedVersion", "defaultVersion"] as const) {
    const v = meta[M[key]];
    if (typeof v === "string" && VERSION_RE.test(v)) out[key] = v;
  }
  return out;
}

export function parseLints(lints: unknown[]): AdvisorLint[] {
  const out: AdvisorLint[] = [];
  for (const l of lints) {
    if (l === null || typeof l !== "object") continue;
    const r = l as Record<string, unknown>;
    const rawName = r[F.name];
    const name = typeof rawName === "string" && LINT_NAME_RE.test(rawName) ? rawName : null;
    const level = ADVISOR_LEVELS.find((x) => x === r[F.level]) ?? null;
    if (!name || !level) continue;
    const categories = Array.isArray(r[F.categories]) ? (r[F.categories] as unknown[]) : [];
    const rawMeta = r[F.metadata];
    const meta = rawMeta !== null && typeof rawMeta === "object" ? (rawMeta as Record<string, unknown>) : {};
    const evidence = metadataEvidence(meta);
    const type = (ADVISOR_OBJECT_TYPES as readonly unknown[]).includes(meta[F.type]) ? (meta[F.type] as string) : null;
    out.push({
      name,
      level,
      security: categories.includes(ADVISOR_SECURITY_CATEGORY),
      schema: safeName(meta[F.schema]),
      // extension_versions_outdated names its extension in extension_name only.
      object: safeName(meta[F.object]) ?? (typeof evidence.extension === "string" ? evidence.extension : null),
      type: type ?? ADVISOR_LINT_OBJECT_TYPE[name] ?? null,
      evidence,
    });
  }
  return out;
}

const LEVEL_SEVERITY: Record<AdvisorLevel, Severity> = { ERROR: "high", WARN: "medium", INFO: "low" };

// Lints whose level under- or over-states what they expose through the Data API (issue #134).
// A table in `public` at high or above raises cross-tenant detections on it (exposedTables), as
// rls_disabled does. Detectors never name a function (an /rpc/ request has no table), so the
// function lints change only their own severity.
export const LINT_SEVERITY: Readonly<Record<string, Partial<Record<AdvisorLevel, Severity>>>> = {
  // RLS off, an API role can SELECT, and column names look like credentials or PII.
  sensitive_columns_exposed: { ERROR: "critical" },
  // splinter flags only write policies (INSERT, UPDATE, DELETE, ALL) that pass every row.
  rls_policy_always_true: { WARN: "high" },
  // Anyone with the anon key runs the function with its owner's rights, past every RLS policy.
  anon_security_definer_function_executable: { WARN: "high" },
  // ERROR: SECURITY DEFINER and the caller's text reaches EXECUTE: any SQL, as the owner.
  anon_dynamic_sql_function_executable: { ERROR: "critical", WARN: "high" },
  // GraphQL introspection shows signed-in users the object's shape, not its rows: RLS still applies.
  pg_graphql_authenticated_table_exposed: { WARN: "low" },
};

export function lintSeverity(name: string, level: AdvisorLevel): Severity {
  return LINT_SEVERITY[name]?.[level] ?? LEVEL_SEVERITY[level];
}

// Security lints become findings, one per lint and object. The Advisor's own "could not run"
// lint makes the whole source unavailable.
export function advisorFindings(lints: AdvisorLint[]): { status: "ok"; findings: PostureFinding[] } | { status: "unavailable" } {
  if (lints.some((l) => l.name === ADVISOR_UNAVAILABLE_LINT)) return { status: "unavailable" };
  const seen = new Set<string>();
  const findings: PostureFinding[] = [];
  for (const l of lints) {
    if (!l.security) continue;
    // A policy or an overload is its own object: rls_policy_always_true reports each policy on a table.
    const part = l.evidence.policy ?? l.evidence.arguments ?? "";
    const key = `${l.name}|${l.schema}|${l.object}|${l.type}|${String(part)}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      source: "advisor", check: l.name, severity: lintSeverity(l.name, l.level), schema: l.schema, object: l.object,
      objectType: l.type, evidence: { ...l.evidence, level: l.level },
    });
  }
  return { status: "ok", findings };
}
