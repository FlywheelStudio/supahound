import { SEVERITY_RANK, type Finding, type Severity } from "../detectors/finding.js";
import type { PostureFinding } from "./types.js";

// What the stored posture findings mean for the dashboard and the detectors (decision 038).

// Advisor lints that report the same thing as one of Supahound's catalog checks.
export const ADVISOR_EQUIVALENT: Readonly<Record<string, string>> = {
  rls_disabled_in_public: "rls_disabled",
  policy_exists_rls_disabled: "rls_disabled",
  rls_enabled_no_policy: "rls_no_policies",
  security_definer_view: "view_not_invoker",
};

// Drops an Advisor finding when a catalog finding already reports the same check on the same
// object. The catalog one stays: its severity knows the grants. Worst first, then by object.
export function dedupePosture<T extends PostureFinding>(findings: T[]): T[] {
  const catalog = new Set(findings.filter((f) => f.source === "catalog").map((f) => `${f.check}|${f.schema}|${f.object}`));
  return findings
    .filter((f) => f.source !== "advisor" || !catalog.has(`${ADVISOR_EQUIVALENT[f.check] ?? "-"}|${f.schema}|${f.object}`))
    .sort((a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity]
      || `${a.schema}.${a.object}.${a.check}`.localeCompare(`${b.schema}.${b.object}.${b.check}`));
}

export type SeverityCounts = Record<Severity, number>;

export function countBySeverity(findings: PostureFinding[]): SeverityCounts {
  const counts: SeverityCounts = { critical: 0, high: 0, medium: 0, low: 0 };
  for (const f of dedupePosture(findings)) counts[f.severity] += 1;
  return counts;
}

// Tables in `public` (the schema the Data API serves and detectors name) with a posture finding
// at high or above: RLS off for an API role, or a policy that opens writes. table → check.
export function exposedTables(findings: PostureFinding[]): Map<string, string> {
  const out = new Map<string, string>();
  for (const f of dedupePosture(findings)) {
    if (f.schema !== "public" || f.object === null || f.objectType !== "table") continue;
    if (SEVERITY_RANK[f.severity] < SEVERITY_RANK.high || out.has(f.object)) continue;
    out.set(f.object, f.check);
  }
  return out;
}

const RAISED: Record<Severity, Severity> = { low: "medium", medium: "high", high: "critical", critical: "critical" };
export const POSTURE_SIGNAL = "posture_exposed";

// A cross-tenant detection on a table that posture shows exposed is one step worse: the request
// most likely did read or change other users' rows. Service-role findings are not raised: the
// service key bypasses RLS, so the table's posture changes nothing about them.
export function raiseForPosture(findings: Finding[], exposed: Map<string, string>): Finding[] {
  if (exposed.size === 0) return findings;
  return findings.map((f) => {
    const table = typeof f.evidence.table === "string" ? f.evidence.table : null;
    const check = table ? exposed.get(table) : undefined;
    if (f.detector !== "cross_tenant" || !check) return f;
    return {
      ...f,
      severity: RAISED[f.severity],
      signals: f.signals.includes(POSTURE_SIGNAL) ? f.signals : [...f.signals, POSTURE_SIGNAL],
      evidence: { ...f.evidence, postureCheck: check },
    };
  });
}
