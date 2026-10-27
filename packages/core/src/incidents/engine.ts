import { maxSeverity, SEVERITY_RANK, type Finding, type Severity } from "../detectors/finding.js";
import { scopeKey, type ProjectScope } from "../tenancy/scope.js";
import { INCIDENT_WINDOW_MINUTES, type Incident } from "./incident.js";

// Groups one poll's findings into incidents: one per actor per project, extended while the
// actor stays active within the 15-minute window (PRD, Scoring; Incident alert). Repeats update
// the open incident instead of paging again.
//
// Severity stays deterministic (the model never decides): the worst finding, raised one level
// when two different detectors fire for the same actor, because signals stack.

export interface IncidentUpdate {
  incident: Incident;
  findings: Finding[];
  // Page someone: a new incident at high or above, or an open one that just reached high.
  notify: boolean;
}

export interface EngineResult {
  updates: IncidentUpdate[];
  // Open incidents whose actor went quiet past the window before acting again.
  resolved: Incident[];
}

const WINDOW_MS = INCIDENT_WINDOW_MINUTES * 60_000;
const NOTIFY_AT: Severity = "high";
const LEVELS: Severity[] = ["low", "medium", "high", "critical"];

function bump(s: Severity): Severity {
  return LEVELS[Math.min(LEVELS.indexOf(s) + 1, LEVELS.length - 1)]!;
}

export function scoreIncident(findingSeverities: Severity[], detectors: Set<string>): Severity {
  const base = maxSeverity(findingSeverities);
  return detectors.size >= 2 ? bump(base) : base;
}

const atLeast = (s: Severity, floor: Severity) => SEVERITY_RANK[s] >= SEVERITY_RANK[floor];

export function applyFindings(scope: ProjectScope, open: Incident[], findings: Finding[], now: Date): EngineResult {
  const key = scopeKey(scope);
  for (const i of open) {
    if (scopeKey(i.scope) !== key) throw new Error("Incident from another project or tenant passed to the engine");
    if (i.status !== "open") throw new Error("Only open incidents may be passed to the engine");
  }

  const byActor = new Map<string, Finding[]>();
  for (const f of findings) byActor.set(f.actor, [...(byActor.get(f.actor) ?? []), f]);

  const updates: IncidentUpdate[] = [];
  const resolved: Incident[] = [];

  for (const [actor, group] of byActor) {
    const lastSeen = new Date(Math.max(...group.map((f) => Date.parse(f.lastSeen)), 0) || now.getTime());
    const firstSeen = new Date(Math.min(...group.map((f) => Date.parse(f.firstSeen))) || now.getTime());
    const current = open.find((i) => i.actor === actor);
    const active = current && firstSeen.getTime() - current.lastSeenAt.getTime() <= WINDOW_MS;
    if (current && !active) resolved.push({ ...current, status: "resolved" });

    const base: Incident = active
      ? current
      : {
          id: null, scope, actor, status: "open", severity: "low", detectors: [], signals: [],
          findingCount: 0, hits: 0, openedAt: firstSeen, lastSeenAt: firstSeen,
        };

    const detectors = new Set([...base.detectors, ...group.map((f) => f.detector)]);
    const severity = scoreIncident([base.severity, ...group.map((f) => f.severity)], detectors);
    const incident: Incident = {
      ...base,
      severity: active ? maxSeverity([base.severity, severity]) : severity,
      detectors: [...detectors].sort() as Incident["detectors"],
      signals: [...new Set([...base.signals, ...group.flatMap((f) => f.signals)])].sort(),
      findingCount: base.findingCount + group.length,
      hits: base.hits + group.reduce((n, f) => n + f.hits, 0),
      lastSeenAt: new Date(Math.max(base.lastSeenAt.getTime(), lastSeen.getTime())),
    };

    const notify = active
      ? !atLeast(base.severity, NOTIFY_AT) && atLeast(incident.severity, NOTIFY_AT)
      : atLeast(incident.severity, NOTIFY_AT);
    updates.push({ incident, findings: group, notify });
  }

  return { updates, resolved };
}
