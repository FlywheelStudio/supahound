import { createHash } from "node:crypto";

export type Severity = "critical" | "high" | "medium" | "low";

export const SEVERITY_RANK: Record<Severity, number> = { critical: 4, high: 3, medium: 2, low: 1 };

export function maxSeverity(list: Severity[]): Severity {
  return list.reduce<Severity>((a, b) => (SEVERITY_RANK[b] > SEVERITY_RANK[a] ? b : a), "low");
}

export type EvidenceValue = string | number | boolean | null;

// A detector's output. Evidence holds structured features only (counts, enums, hashes, ASNs):
// the PRD bars raw attacker-controlled strings (user agents, query values) from later stages.
export interface Finding {
  detector: "cross_tenant" | "service_role_misuse";
  severity: Severity;
  actor: string;
  signals: string[];
  firstSeen: string;
  lastSeen: string;
  hits: number;
  evidence: Record<string, EvidenceValue>;
}

// Short stable fingerprint for a value the alert must reference but not repeat.
export function fingerprint(value: string): string {
  return createHash("sha256").update(value).digest("hex").slice(0, 12);
}
