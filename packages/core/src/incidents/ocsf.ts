import { fingerprint, type Severity } from "../detectors/finding.js";
import { ATTACK_TECHNIQUES, OWASP_API_2023, rulesFor, type DetectionRule, type RuleConfidence } from "../detectors/rules.js";
import type { Incident } from "./incident.js";

// One incident as an OCSF 1.5 Detection Finding (class 2004), for webhooks (#17) and SIEM export.
// A pure function: no transport, no I/O. It carries structured fields only, the same rule as
// detector evidence: rule IDs, ATT&CK and OWASP tags, severity, counts, times, an actor
// fingerprint and, for the service-role key, an ASN. No user IDs, user agents, query values, IPs
// or emails. The only IDs are the incident's own tenant, project and incident UUIDs, so an export
// is addressed to one tenant and names nothing outside it.

export const OCSF_VERSION = "1.5.0";
const DETECTION_FINDING = 2004;
const FINDINGS_CATEGORY = 2;

export type OcsfActivity = "create" | "update" | "close";

const ACTIVITY: Record<OcsfActivity, { id: number; name: string }> = {
  create: { id: 1, name: "Create" },
  update: { id: 2, name: "Update" },
  close: { id: 3, name: "Close" },
};

const SEVERITY: Record<Severity, { id: number; name: string }> = {
  low: { id: 2, name: "Low" },
  medium: { id: 3, name: "Medium" },
  high: { id: 4, name: "High" },
  critical: { id: 5, name: "Critical" },
};

const CONFIDENCE: Record<RuleConfidence, { id: number; name: string }> = {
  low: { id: 1, name: "Low" },
  medium: { id: 2, name: "Medium" },
  high: { id: 3, name: "High" },
};

export interface OcsfAttack {
  technique?: { uid: string; name: string; src_url: string };
  sub_technique?: { uid: string; name: string; src_url: string };
  tactic: { uid: string; name: string; src_url: string };
  version: string;
}

export interface OcsfDetectionFinding {
  activity_id: number;
  activity_name: string;
  category_uid: number;
  category_name: "Findings";
  class_uid: number;
  class_name: "Detection Finding";
  type_uid: number;
  type_name: string;
  severity_id: number;
  severity: string;
  status_id: number;
  status: "New" | "Resolved";
  confidence_id?: number;
  confidence?: string;
  is_alert: true;
  message: string;
  time: number;
  start_time: number;
  end_time: number;
  count: number;
  metadata: {
    version: string;
    product: { name: "Supahound"; vendor_name: "Supahound"; version?: string };
    tenant_uid: string;
    uid: string;
  };
  cloud: { provider: "Supabase"; project_uid: string };
  finding_info: {
    uid: string;
    title: string;
    types: string[];
    created_time: number;
    first_seen_time: number;
    last_seen_time: number;
    analytic?: { uid: string; name: string; type_id: 1; type: "Rule" };
    related_analytics: { uid: string; name: string; type_id: 1; type: "Rule" }[];
    attacks: OcsfAttack[];
    tags: { name: string; value: string }[];
  };
  attacks: OcsfAttack[];
  osint: [];
  unmapped: {
    rule_ids: string[];
    owasp_api: string[];
    detectors: string[];
    signals: string[];
    finding_count: number;
    actor_kind: "signed_in_user" | "service_role_key";
    actor_fingerprint: string;
    asn: number | null;
  };
}

export interface OcsfOptions {
  // Defaults: "close" for a resolved incident, else "create".
  activity?: OcsfActivity;
  // Event time. Defaults to the incident's last activity, so the output is deterministic.
  time?: Date;
  productVersion?: string;
}

export const ATTACK_VERSION = "20.1";
const attackUrl = (id: string) => `https://attack.mitre.org/techniques/${id.replace(".", "/")}/`;
const tacticUrl = (id: string) => `https://attack.mitre.org/tactics/${id}/`;

function attacksOf(rules: DetectionRule[]): OcsfAttack[] {
  const ids = [...new Set(rules.flatMap((r) => r.attack))].sort();
  return ids.map((id) => {
    const t = ATTACK_TECHNIQUES[id];
    const tactic = { uid: t.tactic.uid, name: t.tactic.name, src_url: tacticUrl(t.tactic.uid) };
    if (!id.includes(".")) return { technique: { uid: id, name: t.name, src_url: attackUrl(id) }, tactic, version: ATTACK_VERSION };
    const parent = id.split(".")[0] as keyof typeof ATTACK_TECHNIQUES;
    const parentName = ATTACK_TECHNIQUES[parent]?.name ?? t.name.split(":")[0]!;
    return {
      technique: { uid: parent, name: parentName, src_url: attackUrl(parent) },
      sub_technique: { uid: id, name: t.name, src_url: attackUrl(id) },
      tactic,
      version: ATTACK_VERSION,
    };
  });
}

const RANK: Record<RuleConfidence, number> = { low: 1, medium: 2, high: 3 };

// The service-role actor is `service_role:asn:<n>`, or `service_role:net:<fingerprint>` when the
// log has no ASN (#184); only the ASN form carries a structured feature.
function asnOf(actor: string): number | null {
  const m = /^service_role:asn:(\d{1,10})$/.exec(actor);
  return m ? Number(m[1]) : null;
}

export function incidentToOcsf(incident: Incident, options: OcsfOptions = {}): OcsfDetectionFinding {
  if (incident.id === null) throw new Error("Only a saved incident can be exported: it needs its ID");
  const activity = ACTIVITY[options.activity ?? (incident.status === "resolved" ? "close" : "create")];
  const severity = SEVERITY[incident.severity];
  const rules = rulesFor(incident.detectors, incident.signals);
  const primary = rules[0];
  const attacks = attacksOf(rules);
  const owasp = [...new Set(rules.flatMap((r) => r.owaspApi))].sort();
  const best = rules.reduce<RuleConfidence | null>((a, r) => (a === null || RANK[r.confidence] > RANK[a] ? r.confidence : a), null);
  const serviceRole = incident.actor.startsWith("service_role:");
  const title = primary?.title ?? "Unusual activity";
  const analytic = (r: DetectionRule) => ({ uid: r.id, name: r.title, type_id: 1 as const, type: "Rule" as const });

  return {
    activity_id: activity.id,
    activity_name: activity.name,
    category_uid: FINDINGS_CATEGORY,
    category_name: "Findings",
    class_uid: DETECTION_FINDING,
    class_name: "Detection Finding",
    type_uid: DETECTION_FINDING * 100 + activity.id,
    type_name: `Detection Finding: ${activity.name}`,
    severity_id: severity.id,
    severity: severity.name,
    status_id: incident.status === "resolved" ? 4 : 1,
    status: incident.status === "resolved" ? "Resolved" : "New",
    ...(best ? { confidence_id: CONFIDENCE[best].id, confidence: CONFIDENCE[best].name } : {}),
    is_alert: true,
    message: title,
    time: (options.time ?? incident.lastSeenAt).getTime(),
    start_time: incident.openedAt.getTime(),
    end_time: incident.lastSeenAt.getTime(),
    count: incident.hits,
    metadata: {
      version: OCSF_VERSION,
      product: { name: "Supahound", vendor_name: "Supahound", ...(options.productVersion ? { version: options.productVersion } : {}) },
      tenant_uid: incident.scope.tenantId,
      uid: incident.id,
    },
    cloud: { provider: "Supabase", project_uid: incident.scope.projectId },
    finding_info: {
      uid: incident.id,
      title,
      types: [...incident.detectors].sort(),
      created_time: incident.openedAt.getTime(),
      first_seen_time: incident.openedAt.getTime(),
      last_seen_time: incident.lastSeenAt.getTime(),
      ...(primary ? { analytic: analytic(primary) } : {}),
      related_analytics: rules.slice(1).map(analytic),
      attacks,
      tags: owasp.map((id) => ({ name: "owasp_api_2023", value: `${id} ${OWASP_API_2023[id]}` })),
    },
    attacks,
    osint: [],
    unmapped: {
      rule_ids: rules.map((r) => r.id),
      owasp_api: owasp,
      detectors: [...incident.detectors].sort(),
      // Only signals with a rule: the set is closed, so no free text leaves through it.
      signals: [...new Set(rules.map((r) => r.signal))].sort(),
      finding_count: incident.findingCount,
      actor_kind: serviceRole ? "service_role_key" : "signed_in_user",
      actor_fingerprint: fingerprint(incident.actor),
      asn: serviceRole ? asnOf(incident.actor) : null,
    },
  };
}
