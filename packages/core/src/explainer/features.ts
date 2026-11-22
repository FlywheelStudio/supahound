import { safeIdentifier, type Finding, type Severity } from "../detectors/finding.js";
import { INCIDENT_WINDOW_MINUTES, type Incident } from "../incidents/incident.js";

// The only data a model ever sees: one incident of one tenant, reduced to enums, counts, ASNs
// and schema identifiers. No user IDs (the actor becomes "actor A"), no user agents, no query
// values, no IPs, no emails, no project refs, no tenant or project names (PRD, Security of
// Supahound itself). Every field is rebuilt from a whitelist, never copied as free text.

export interface IncidentFeatures {
  actor: "actor A";
  actorKind: "signed_in_user" | "service_role_key" | "anon_key";
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
  rpcExposure?: {
    functions: string[];
    // Who called: "anon" (issue #131) and/or "authenticated" (#157).
    roles: string[];
    postureChecks: string[];
    postureSeverities: Severity[];
    methods: string[];
    callerClasses: string[];
    networkTypes: string[];
    asns: number[];
  };
  exposedRead?: {
    tables: string[];
    postureChecks: string[];
    postureSeverities: Severity[];
    // Rows the anon key received across the incident's findings; null when no response said.
    rowsReturned: number | null;
    callerClasses: string[];
    networkTypes: string[];
    asns: number[];
  };
  storageListing?: {
    // Only buckets posture named (public_bucket_allows_listing); others are counted, never named.
    buckets: string[];
    unnamedBuckets: number;
    postureChecks: string[];
    callerClasses: string[];
    networkTypes: string[];
    asns: number[];
  };
}

const SIGNALS = new Set([
  "other_owner", "all_but_self", "excludes_other", "pattern", "range", "any_owner",
  "browser_caller", "mobile_app_caller", "non_hosting_network", "manual_tool", "new_network",
  // The table's posture is exposed (decision 038): RLS off, or a policy that opens writes.
  "posture_exposed",
  // Anon calls to a SECURITY DEFINER function posture shows anon-executable (issue #131).
  "definer_rpc_call", "rpc_burst",
  // Anon reads of a table posture shows readable by anon (issue #132).
  "exposed_table_read", "rows_returned", "bulk_read",
  // Signed-in calls to a SECURITY DEFINER function (#157), and anon Storage listing (#157).
  "authenticated_definer_call", "anon_bucket_list", "listable_bucket", "list_burst",
]);
const RPC_ROLES = new Set(["anon", "authenticated"]);
// A Storage bucket id as posture stores it (Advisor object names pass safeName).
const bucketName = (v: unknown): string | null => (typeof v === "string" && /^[A-Za-z0-9][A-Za-z0-9_.-]{0,62}$/.test(v) ? v : null);
const hex12 = (v: unknown): string | null => (typeof v === "string" && /^[0-9a-f]{12}$/.test(v) ? v : null);
const METHODS = new Set(["GET", "HEAD", "PATCH", "PUT", "DELETE", "POST"]);
const OUTCOMES = new Set(["rejected", "empty", "rows_returned", "unknown"]);
const CALLER_CLASSES = new Set(["browser", "mobile_app", "manual_tool", "server", "unknown"]);
const NETWORK_TYPES = new Set(["hosting", "other", "unknown"]);
const SEVERITIES = new Set(["critical", "high", "medium", "low"]);
const RPC_METHODS = new Set(["GET", "HEAD", "POST", "mixed"]);
// A posture check name: a catalog check or an Advisor lint, both plain snake_case.
const check = (v: unknown): string | null => (typeof v === "string" && /^[a-z][a-z0-9_]{0,63}$/.test(v) ? v : null);

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
  const rpc = findings.filter((f) => f.detector === "rpc_exposure");
  const anonReads = findings.filter((f) => f.detector === "exposed_read");
  const listings = findings.filter((f) => f.detector === "storage_listing");
  const durationMs = incident.lastSeenAt.getTime() - incident.openedAt.getTime();

  const features: IncidentFeatures = {
    actor: "actor A",
    actorKind: incident.actor.startsWith("service_role:") ? "service_role_key"
      : incident.actor.startsWith("anon:") ? "anon_key" : "signed_in_user",
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
  if (rpc.length > 0) {
    features.rpcExposure = {
      functions: uniq(rpc.map((f) => ident(f.evidence.function))),
      // Findings saved before #157 carry no role: they were all anon.
      roles: uniq(rpc.map((f) => (f.evidence.role === undefined ? "anon" : pick(RPC_ROLES, f.evidence.role)))),
      postureChecks: uniq(rpc.map((f) => check(f.evidence.postureCheck))),
      postureSeverities: uniq(rpc.map((f) => pick(SEVERITIES, f.evidence.postureSeverity) as Severity | null)),
      methods: uniq(rpc.map((f) => pick(RPC_METHODS, f.evidence.method))),
      callerClasses: uniq(rpc.map((f) => pick(CALLER_CLASSES, f.evidence.callerClass))),
      networkTypes: uniq(rpc.map((f) => pick(NETWORK_TYPES, f.evidence.networkType))),
      asns: uniq(rpc.map((f) => count(f.evidence.asn))),
    };
  }
  if (anonReads.length > 0) {
    const rows = anonReads.map((f) => count(f.evidence.rowsReturned)).filter((n): n is number => n !== null);
    features.exposedRead = {
      tables: uniq(anonReads.map((f) => ident(f.evidence.table))),
      postureChecks: uniq(anonReads.map((f) => check(f.evidence.postureCheck))),
      postureSeverities: uniq(anonReads.map((f) => pick(SEVERITIES, f.evidence.postureSeverity) as Severity | null)),
      rowsReturned: rows.length > 0 ? rows.reduce((a, b) => a + b, 0) : null,
      callerClasses: uniq(anonReads.map((f) => pick(CALLER_CLASSES, f.evidence.callerClass))),
      networkTypes: uniq(anonReads.map((f) => pick(NETWORK_TYPES, f.evidence.networkType))),
      asns: uniq(anonReads.map((f) => count(f.evidence.asn))),
    };
  }
  if (listings.length > 0) {
    const named = listings.filter((f) => bucketName(f.evidence.bucket) !== null);
    features.storageListing = {
      buckets: uniq(named.map((f) => bucketName(f.evidence.bucket))),
      unnamedBuckets: uniq(listings.filter((f) => !named.includes(f)).map((f) => hex12(f.evidence.bucketFingerprint))).length,
      postureChecks: uniq(listings.map((f) => check(f.evidence.postureCheck))),
      callerClasses: uniq(listings.map((f) => pick(CALLER_CLASSES, f.evidence.callerClass))),
      networkTypes: uniq(listings.map((f) => pick(NETWORK_TYPES, f.evidence.networkType))),
      asns: uniq(listings.map((f) => count(f.evidence.asn))),
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
