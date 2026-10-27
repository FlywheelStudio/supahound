import { safeIdentifier, type Finding, type Severity } from "../detectors/finding.js";
import { INCIDENT_WINDOW_MINUTES, type Incident } from "../incidents/incident.js";

// The only data a model ever sees: one incident of one tenant, reduced to enums, counts, ASNs
// and schema identifiers. No user IDs (the actor becomes "actor A"), no user agents, no query
// values, no IPs, no emails, no project refs, no tenant or project names (PRD, Security of
// Guardbase itself). Every field is rebuilt from a whitelist, never copied as free text.

export interface IncidentFeatures {
  actor: "actor A";
  actorKind: "signed_in_user" | "service_role_key";
  severity: Severity;
  detectors: Finding["detector"][];
  signals: string[];
  findingCount: number;
  hits: number;
  windowMinutes: number;
  durationMinutes: number;
  crossTenant?: {
    tables: string[];
    columns: string[];
    methods: string[];
    outcomes: string[];
    maxRowsReturned: number | null;
    foreignIdCount: number;
    multiParty: boolean;
  };
  serviceRole?: {
    callerClasses: string[];
    sdks: string[];
    networkTypes: string[];
    asns: number[];
    declaredNetwork: boolean;
    tables: string[];
  };
}

const SIGNALS = new Set([
  "other_owner", "all_but_self", "excludes_other", "pattern", "range", "any_owner",
  "browser_caller", "mobile_app_caller", "non_hosting_network", "manual_tool", "new_network",
]);
const METHODS = new Set(["GET", "HEAD", "PATCH", "PUT", "DELETE", "POST"]);
const OUTCOMES = new Set(["rejected", "empty", "rows_returned", "unknown"]);
const CALLER_CLASSES = new Set(["browser", "mobile_app", "manual_tool", "server", "unknown"]);
const NETWORK_TYPES = new Set(["hosting", "other", "unknown"]);

const pick = (set: Set<string>, v: unknown): string | null => (typeof v === "string" && set.has(v) ? v : null);
const count = (v: unknown): number | null => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? v : null);
const ident = (v: unknown): string | null => safeIdentifier(typeof v === "string" ? v : null);
const sdk = (v: unknown): string | null => (typeof v === "string" && /^[a-z][a-z0-9-]{0,40}$/.test(v) ? v : null);

function uniq<T>(values: (T | null)[]): T[] {
  return [...new Set(values.filter((v): v is T => v !== null))].sort();
}

export function buildFeatures(incident: Incident, findings: Finding[]): IncidentFeatures {
  const cross = findings.filter((f) => f.detector === "cross_tenant");
  const service = findings.filter((f) => f.detector === "service_role_misuse");
  const durationMs = incident.lastSeenAt.getTime() - incident.openedAt.getTime();

  const features: IncidentFeatures = {
    actor: "actor A",
    actorKind: incident.actor.startsWith("service_role:") ? "service_role_key" : "signed_in_user",
    severity: incident.severity,
    detectors: [...incident.detectors].sort(),
    signals: uniq(incident.signals.map((s) => pick(SIGNALS, s))),
    findingCount: incident.findingCount,
    hits: incident.hits,
    windowMinutes: INCIDENT_WINDOW_MINUTES,
    durationMinutes: Math.max(0, Math.round(durationMs / 60_000)),
  };

  if (cross.length > 0) {
    const rows = uniq(cross.map((f) => count(f.evidence.rowsReturned)));
    features.crossTenant = {
      tables: uniq(cross.map((f) => ident(f.evidence.table))),
      columns: uniq(cross.map((f) => ident(f.evidence.column))),
      methods: uniq(cross.map((f) => pick(METHODS, f.evidence.method))),
      outcomes: uniq(cross.map((f) => pick(OUTCOMES, f.evidence.outcome))),
      maxRowsReturned: rows.length > 0 ? Math.max(...rows) : null,
      foreignIdCount: cross.reduce((n, f) => n + (count(f.evidence.foreignIdCount) ?? 0), 0),
      multiParty: cross.some((f) => f.evidence.tableShape === "multi_party"),
    };
  }

  if (service.length > 0) {
    features.serviceRole = {
      callerClasses: uniq(service.map((f) => pick(CALLER_CLASSES, f.evidence.callerClass))),
      sdks: uniq(service.map((f) => sdk(f.evidence.sdk))),
      networkTypes: uniq(service.map((f) => pick(NETWORK_TYPES, f.evidence.networkType))),
      asns: uniq(service.map((f) => count(f.evidence.asn))),
      declaredNetwork: service.some((f) => f.evidence.expectedNetwork === true),
      tables: uniq(service.map((f) => ident(f.evidence.table))),
    };
  }
  return features;
}

// Every number and identifier the model may repeat. The validator rejects anything else.
export function allowedFacts(features: IncidentFeatures): { numbers: Set<number>; identifiers: Set<string> } {
  const numbers = new Set<number>();
  const identifiers = new Set<string>(["auth.uid()", "service_role", "anon", "authenticated"]);
  const walk = (v: unknown, key: string): void => {
    if (typeof v === "number") numbers.add(v);
    else if (Array.isArray(v)) v.forEach((x) => walk(x, key));
    else if (v && typeof v === "object") for (const [k, x] of Object.entries(v)) walk(x, k);
    else if (typeof v === "string" && key !== "actor") identifiers.add(v);
  };
  walk(features, "");
  return { numbers, identifiers };
}
