import {
  ADVISOR_FIELDS as F, ADVISOR_LEVELS, ADVISOR_OBJECT_TYPES, ADVISOR_PATH, ADVISOR_SECURITY_CATEGORY, ADVISOR_UNAVAILABLE_LINT,
  LINT_NAME_RE, MAX_ADVISOR_LINTS, type AdvisorLevel,
} from "../config/posture.js";
import type { Severity } from "../detectors/finding.js";
import { MANAGEMENT_API } from "../logs/client.js";
import { QUERY_TIMEOUT_MS } from "../ownership/client.js";
import { safeName } from "./catalog.js";
import type { PostureFinding } from "./types.js";

// Supabase Security Advisor (issue #11, decision 038): GET /v1/projects/{ref}/advisors/security.
// Experimental in the Management API reference; scope database:read. A failure of any kind is
// "unable to assess" for this source, never zero findings.
//
// Only structured fields leave this module: the lint name (a snake_case enum), its level, the
// object type (an enum) and the object's schema and name (catalog identifiers). The free text
// fields (title, description, detail, remediation) are never read.

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
    out.push({
      name,
      level,
      security: categories.includes(ADVISOR_SECURITY_CATEGORY),
      schema: safeName(meta[F.schema]),
      object: safeName(meta[F.object]),
      type: (ADVISOR_OBJECT_TYPES as readonly unknown[]).includes(meta[F.type]) ? (meta[F.type] as string) : null,
    });
  }
  return out;
}

const LEVEL_SEVERITY: Record<AdvisorLevel, Severity> = { ERROR: "high", WARN: "medium", INFO: "low" };

// Security lints become findings, one per lint and object. The Advisor's own "could not run"
// lint makes the whole source unavailable.
export function advisorFindings(lints: AdvisorLint[]): { status: "ok"; findings: PostureFinding[] } | { status: "unavailable" } {
  if (lints.some((l) => l.name === ADVISOR_UNAVAILABLE_LINT)) return { status: "unavailable" };
  const seen = new Set<string>();
  const findings: PostureFinding[] = [];
  for (const l of lints) {
    if (!l.security) continue;
    const key = `${l.name}|${l.schema}|${l.object}|${l.type}`;
    if (seen.has(key)) continue;
    seen.add(key);
    findings.push({
      source: "advisor", check: l.name, severity: LEVEL_SEVERITY[l.level], schema: l.schema, object: l.object,
      objectType: l.type, evidence: { level: l.level },
    });
  }
  return { status: "ok", findings };
}
