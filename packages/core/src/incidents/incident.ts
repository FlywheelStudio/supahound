import type { Finding, Severity } from "../detectors/finding.js";
import type { ProjectScope } from "../tenancy/scope.js";

// One incident: everything one actor did in one project of one tenant, grouped over a sliding
// 15-minute window (PRD, Scoring). The scope is part of the identity, so incidents from two
// projects or two tenants can never merge.
export interface Incident {
  id: string | null;
  scope: ProjectScope;
  actor: string;
  status: "open" | "resolved";
  severity: Severity;
  detectors: Finding["detector"][];
  signals: string[];
  findingCount: number;
  hits: number;
  openedAt: Date;
  lastSeenAt: Date;
}

export const INCIDENT_WINDOW_MINUTES = 15;
