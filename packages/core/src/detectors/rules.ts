import { POSTURE_SIGNAL } from "../posture/findings.js";
import { MISMATCH_KINDS, type MismatchKind } from "./crossTenant.js";
import { EXPOSED_READ_SIGNALS, type ExposedReadSignal } from "./exposedRead.js";
import { RPC_EXPOSURE_SIGNALS, type RpcExposureSignal } from "./rpcExposure.js";
import type { Finding } from "./finding.js";
import { SERVICE_ROLE_SIGNALS, type ServiceRoleSignal } from "./serviceRole.js";

// Detection rules: one stable ID per detector signal, tagged with MITRE ATT&CK techniques and
// OWASP API Security Top 10 (2023) categories, so findings map onto the frameworks SIEMs and
// auditors use. Rule IDs are derived from a finding's detector and signals, so the stored shape of
// findings and incidents does not change.
//
// Adding a detector or a signal: add the signal to the detector's exported list, then add its
// entry below. The `satisfies` clause fails the typecheck until every signal of every detector has
// a rule, and rules.test.ts checks the same at runtime. Never renumber or reuse an ID: webhook
// consumers key on it. Retire a rule by leaving its number unused.

// ATT&CK techniques the rules cite. Each ID checked against attack.mitre.org (Enterprise v20.1,
// 2026-11-22).
// The tactic is the one that fits how the rule sees the technique; ATT&CK may list others.
export const ATTACK_TECHNIQUES = {
  T1190: { name: "Exploit Public-Facing Application", tactic: { uid: "TA0001", name: "Initial Access" } },
  T1078: { name: "Valid Accounts", tactic: { uid: "TA0001", name: "Initial Access" } },
  "T1078.004": { name: "Valid Accounts: Cloud Accounts", tactic: { uid: "TA0001", name: "Initial Access" } },
  T1213: { name: "Data from Information Repositories", tactic: { uid: "TA0009", name: "Collection" } },
  T1552: { name: "Unsecured Credentials", tactic: { uid: "TA0006", name: "Credential Access" } },
  "T1552.001": { name: "Unsecured Credentials: Credentials In Files", tactic: { uid: "TA0006", name: "Credential Access" } },
} as const;

export type AttackTechniqueId = keyof typeof ATTACK_TECHNIQUES;

// OWASP API Security Top 10, 2023 edition.
export const OWASP_API_2023 = {
  "API1:2023": "Broken Object Level Authorization",
  "API2:2023": "Broken Authentication",
  "API3:2023": "Broken Object Property Level Authorization",
  "API4:2023": "Unrestricted Resource Consumption",
  "API5:2023": "Broken Function Level Authorization",
  "API6:2023": "Unrestricted Access to Sensitive Business Flows",
  "API7:2023": "Server Side Request Forgery",
  "API8:2023": "Security Misconfiguration",
  "API9:2023": "Improper Inventory Management",
  "API10:2023": "Unsafe Consumption of APIs",
} as const;

export type OwaspApiId = keyof typeof OWASP_API_2023;

// How often the signal alone means abuse, before any customer tuning.
export type RuleConfidence = "low" | "medium" | "high";

export interface RuleSpec {
  id: string;
  title: string;
  attack: readonly AttackTechniqueId[];
  owaspApi: readonly OwaspApiId[];
  confidence: RuleConfidence;
  falsePositives: string;
}

export type Detector = Finding["detector"];

// The signals each detector can emit. A new detector adds its list here and its rules below.
export interface DetectorSignals {
  cross_tenant: MismatchKind | typeof POSTURE_SIGNAL;
  service_role_misuse: ServiceRoleSignal;
  exposed_read: ExposedReadSignal;
  rpc_exposure: RpcExposureSignal;
}

export const DETECTOR_SIGNALS: { readonly [D in Detector]: readonly DetectorSignals[D][] } = {
  cross_tenant: [...MISMATCH_KINDS, POSTURE_SIGNAL],
  service_role_misuse: SERVICE_ROLE_SIGNALS,
  exposed_read: EXPOSED_READ_SIGNALS,
  rpc_exposure: RPC_EXPOSURE_SIGNALS,
};

const RULES = {
  // Detector 2: cross-tenant access (a signed-in user filters an owner column by another ID).
  cross_tenant: {
    other_owner: {
      id: "SH-D2-001",
      title: "Signed-in user filtered an owner column by another user's ID",
      attack: ["T1078"],
      owaspApi: ["API1:2023"],
      confidence: "high",
      falsePositives: "Support or admin users whose wider access comes from a policy the ownership map does not model.",
    },
    all_but_self: {
      id: "SH-D2-002",
      title: "Signed-in user asked for every owner's rows except their own",
      attack: ["T1078", "T1213"],
      owaspApi: ["API1:2023"],
      confidence: "high",
      falsePositives: "A feature that lists other users' public records through an owner-filtered table.",
    },
    excludes_other: {
      id: "SH-D2-003",
      title: "Signed-in user asked for every owner's rows except one other user's",
      attack: ["T1078", "T1213"],
      owaspApi: ["API1:2023"],
      confidence: "medium",
      falsePositives: "Block or hide lists that exclude one user from a shared feed.",
    },
    pattern: {
      id: "SH-D2-004",
      title: "Signed-in user pattern-matched owner IDs",
      attack: ["T1078", "T1213"],
      owaspApi: ["API1:2023"],
      confidence: "medium",
      falsePositives: "Admin search screens that match on owner IDs.",
    },
    range: {
      id: "SH-D2-005",
      title: "Signed-in user swept a range of owner IDs",
      attack: ["T1078", "T1213"],
      owaspApi: ["API1:2023"],
      confidence: "medium",
      falsePositives: "Keyset pagination ordered by an owner column.",
    },
    any_owner: {
      id: "SH-D2-006",
      title: "Signed-in user asked for rows of any owner",
      attack: ["T1078", "T1213"],
      owaspApi: ["API1:2023"],
      confidence: "medium",
      falsePositives: "Client code that adds a not-null guard on an owner column; RLS still limits the rows.",
    },
    [POSTURE_SIGNAL]: {
      id: "SH-D2-007",
      title: "Cross-tenant request on a table that posture shows exposed",
      attack: ["T1078", "T1213"],
      owaspApi: ["API1:2023", "API8:2023"],
      confidence: "high",
      falsePositives: "A table meant to be public that still has an owner column in its policies.",
    },
  },
  // Detector 4: service-role misuse.
  service_role_misuse: {
    browser_caller: {
      id: "SH-D4-001",
      title: "Service-role key used from a browser",
      attack: ["T1552.001", "T1078.004"],
      owaspApi: ["API8:2023", "API5:2023"],
      confidence: "high",
      falsePositives: "Server-side rendering or a headless test runner that sends a browser user agent with the service key.",
    },
    mobile_app_caller: {
      id: "SH-D4-002",
      title: "Service-role key used from a mobile app",
      attack: ["T1552.001", "T1078.004"],
      owaspApi: ["API8:2023", "API5:2023"],
      confidence: "high",
      falsePositives: "A backend written in Dart or Kotlin whose HTTP client looks like a mobile app.",
    },
    non_hosting_network: {
      id: "SH-D4-003",
      title: "Service-role key used from a non-hosting network",
      attack: ["T1078.004", "T1552"],
      owaspApi: ["API2:2023"],
      confidence: "medium",
      falsePositives: "Developers running scripts from a home or office network; declare those networks to silence it.",
    },
    manual_tool: {
      id: "SH-D4-004",
      title: "Service-role key used from a manual tool",
      attack: ["T1078.004"],
      owaspApi: ["API2:2023"],
      confidence: "low",
      falsePositives: "Engineers using curl or Postman for maintenance.",
    },
    new_network: {
      id: "SH-D4-005",
      title: "Service-role key used from a hosting network not seen before",
      attack: ["T1078.004"],
      owaspApi: ["API2:2023"],
      confidence: "low",
      falsePositives: "A deploy to a new cloud provider or region.",
    },
  },
  // Detector 11: anon-key reads of a table the posture scan shows open to anon (issue #132).
  // The PRD and roadmap number detectors 1 to 10, so the baseline-free additions start at 11.
  exposed_read: {
    exposed_table_read: {
      id: "SH-D11-001",
      title: "Anon key read a table that posture shows open to anon",
      attack: ["T1190", "T1213"],
      owaspApi: ["API8:2023", "API1:2023"],
      confidence: "medium",
      falsePositives: "A table meant to be public, such as a product catalog, with RLS off or a read-all policy.",
    },
    rows_returned: {
      id: "SH-D11-002",
      title: "Anon key got rows back from a table open to anon",
      attack: ["T1190", "T1213"],
      owaspApi: ["API8:2023", "API1:2023"],
      confidence: "medium",
      falsePositives: "Public lookup tables read by the app's own anonymous visitors.",
    },
    bulk_read: {
      id: "SH-D11-003",
      title: "Anon key read 1,000 or more rows from a table open to anon in one poll",
      attack: ["T1190", "T1213"],
      owaspApi: ["API8:2023", "API1:2023"],
      confidence: "high",
      falsePositives: "A public data export or a large public catalog fetched in one page.",
    },
  },
  // Detector 12: anon calls to a SECURITY DEFINER function posture shows anon-executable (issue #131).
  rpc_exposure: {
    definer_rpc_call: {
      id: "SH-D12-001",
      title: "Anon key called a SECURITY DEFINER function that anon may execute",
      attack: ["T1190"],
      owaspApi: ["API5:2023", "API8:2023"],
      confidence: "medium",
      falsePositives: "A function deliberately exposed to signed-out users, such as a public counter or sign-up helper.",
    },
    rpc_burst: {
      id: "SH-D12-002",
      title: "Anon key called such a function 100 times or more in one poll",
      attack: ["T1190"],
      owaspApi: ["API5:2023", "API8:2023"],
      confidence: "high",
      falsePositives: "A busy public endpoint that is meant to run as its owner.",
    },
  },
} as const satisfies { [D in Detector]: Record<DetectorSignals[D], RuleSpec> };

export interface DetectionRule extends RuleSpec {
  detector: Detector;
  signal: string;
}

export const DETECTION_RULES: readonly DetectionRule[] = Object.entries(RULES).flatMap(([detector, bySignal]) =>
  Object.entries(bySignal).map(([signal, spec]) => ({ ...(spec as RuleSpec), detector: detector as Detector, signal })),
);

const BY_KEY = new Map(DETECTION_RULES.map((r) => [`${r.detector}|${r.signal}`, r]));

export function ruleFor(detector: string, signal: string): DetectionRule | null {
  return BY_KEY.get(`${detector}|${signal}`) ?? null;
}

// The rules behind a set of signals. An incident stores its detectors and signals as two lists,
// so each signal is looked up under every detector; signal names are unique across detectors
// (rules.test.ts checks). Unknown signals, such as ones from a retired rule, are skipped.
export function rulesFor(detectors: readonly string[], signals: readonly string[]): DetectionRule[] {
  const out = new Map<string, DetectionRule>();
  for (const s of signals) {
    for (const d of detectors) {
      const r = ruleFor(d, s);
      if (r) out.set(r.id, r);
    }
  }
  return [...out.values()].sort((a, b) => a.id.localeCompare(b.id));
}

// A finding's rule IDs, derived from its detector and signals.
export function findingRuleIds(f: Pick<Finding, "detector" | "signals">): string[] {
  return rulesFor([f.detector], f.signals).map((r) => r.id);
}

// An incident's rule IDs, derived from its detectors and signals.
export function incidentRuleIds(i: { detectors: readonly string[]; signals: readonly string[] }): string[] {
  return rulesFor(i.detectors, i.signals).map((r) => r.id);
}
