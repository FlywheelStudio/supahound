import { effectiveRole, type EdgeEvent } from "../logs/event.js";
import { tableFromPath } from "../postgrest/query.js";
import { classifyCaller, classifyNetwork, networkMemoryKey, networkName } from "../network/classify.js";
import { scopeKey, type ProjectScope } from "../tenancy/scope.js";
import { fingerprint, maxSeverity, safeIdentifier, type Finding, type Severity } from "./finding.js";

// Detector 4: the service-role key used from a browser, a mobile app, a non-hosting network,
// or a hosting network the project has not used before.
// Baseline-free: the caller and network checks need no history. Only `new_network` needs
// the seen-set below, which is light state, not a statistical baseline.

// Hosting networks each project's service key has been seen from, keyed by tenant + Supahound
// project ID. Never by Supabase ref: two tenants can watch the same Supabase project.
// The poller loads it from and saves it to the database around each poll.
// ASNs and names are kept apart, each with its own seeded state (decision 050): edge logs mostly
// omit the ASN, so a project seeded by ASN must still learn its names silently the first time.
export class ServiceRoleNetworks {
  private readonly seen = new Map<string, Set<number>>();
  private readonly names = new Map<string, Set<string>>();

  isSeeded(scope: ProjectScope): boolean {
    return this.seen.has(scopeKey(scope));
  }

  has(scope: ProjectScope, asn: number): boolean {
    return this.seen.get(scopeKey(scope))?.has(asn) ?? false;
  }

  learn(scope: ProjectScope, asns: Iterable<number>): void {
    const key = scopeKey(scope);
    const set = this.seen.get(key) ?? new Set<number>();
    for (const asn of asns) set.add(asn);
    this.seen.set(key, set);
  }

  known(scope: ProjectScope): number[] {
    return [...(this.seen.get(scopeKey(scope)) ?? [])].sort((a, b) => a - b);
  }

  isNamesSeeded(scope: ProjectScope): boolean {
    return this.names.has(scopeKey(scope));
  }

  hasName(scope: ProjectScope, name: string): boolean {
    return this.names.get(scopeKey(scope))?.has(name) ?? false;
  }

  learnNames(scope: ProjectScope, names: Iterable<string>): void {
    const key = scopeKey(scope);
    const set = this.names.get(key) ?? new Set<string>();
    for (const n of names) set.add(n);
    this.names.set(key, set);
  }

  knownNames(scope: ProjectScope): string[] {
    return [...(this.names.get(scopeKey(scope)) ?? [])].sort();
  }
}

export interface ServiceRoleContext {
  scope: ProjectScope;
  networks: ServiceRoleNetworks;
  // Networks the customer declared as their own servers. Silences network signals only:
  // a browser holding the service key is a leak wherever it sits.
  expectedAsns?: ReadonlySet<number>;
  // Networks an Owner or Admin marked as expected, by normalized name (decision 050). Same rule:
  // network signals only.
  expectedNetworks?: ReadonlySet<string>;
}

const SIGNAL_SEVERITY = {
  browser_caller: "critical",
  mobile_app_caller: "critical",
  non_hosting_network: "high",
  manual_tool: "medium",
  new_network: "medium",
} as const satisfies Record<string, Severity>;

// The signals this detector emits. Each one needs a rule in `rules.ts` (rules.test.ts checks).
export type ServiceRoleSignal = keyof typeof SIGNAL_SEVERITY;
export const SERVICE_ROLE_SIGNALS = Object.keys(SIGNAL_SEVERITY) as ServiceRoleSignal[];

// The incident key for a service-role caller: the ASN when the log has one, else a fingerprint of
// the network's name, else `unknown`. Edge logs mostly omit the ASN (#184); one shared `unknown`
// actor would group a cloud server and a home connection into one incident.
export function serviceRoleActor(asn: number | null, asOrganization: string | null): string {
  if (asn !== null) return `service_role:asn:${asn}`;
  const name = networkName(asOrganization);
  return name === null ? "service_role:asn:unknown" : `service_role:net:${fingerprint(name)}`;
}

// Processes one poll's events. On a project's first poll, hosting networks are learned
// without a `new_network` signal; every other signal fires from the first poll.
export function detectServiceRoleMisuse(events: EdgeEvent[], ctx: ServiceRoleContext): Finding[] {
  const seeding = !ctx.networks.isSeeded(ctx.scope);
  const seedingNames = !ctx.networks.isNamesSeeded(ctx.scope);
  const findings: Finding[] = [];
  const learned = new Set<number>();
  const learnedNames = new Set<string>();

  for (const event of events) {
    if (effectiveRole(event) !== "service_role") continue;

    const caller = classifyCaller(event.userAgent, event.clientInfo);
    const network = classifyNetwork(event.asn, event.asOrganization);
    const name = networkName(event.asOrganization);
    const memoryKey = networkMemoryKey(event.asOrganization);
    const expected = (event.asn !== null && (ctx.expectedAsns?.has(event.asn) ?? false))
      || (name !== null && (ctx.expectedNetworks?.has(name) ?? false));
    const signals: ServiceRoleSignal[] = [];

    if (caller.callerClass === "browser") signals.push("browser_caller");
    if (caller.callerClass === "mobile_app") signals.push("mobile_app_caller");
    if (caller.callerClass === "manual_tool") signals.push("manual_tool");
    if (!expected && network === "other") signals.push("non_hosting_network");
    if (!expected && network === "hosting") {
      // By ASN when the log has one; else by provider, or by name for a generic host (decision 050).
      const isNew = event.asn !== null
        ? !seeding && !ctx.networks.has(ctx.scope, event.asn)
        : memoryKey !== null && !seedingNames && !ctx.networks.hasName(ctx.scope, memoryKey);
      if (isNew) signals.push("new_network");
    }

    // Learn only hosting networks seen from server-like callers, so a leaked key used from
    // a cloud VM by a browser automation tool does not teach itself in.
    if (network === "hosting" && (caller.callerClass === "server" || caller.callerClass === "unknown")) {
      if (event.asn !== null) learned.add(event.asn);
      else if (memoryKey !== null) learnedNames.add(memoryKey);
    }

    if (signals.length === 0) continue;
    findings.push({
      detector: "service_role_misuse",
      severity: maxSeverity(signals.map((s) => SIGNAL_SEVERITY[s])),
      actor: serviceRoleActor(event.asn, event.asOrganization),
      signals,
      firstSeen: event.firstSeen,
      lastSeen: event.lastSeen,
      hits: event.hits,
      evidence: {
        callerClass: caller.callerClass,
        sdk: caller.sdk,
        networkType: network,
        asn: event.asn,
        // The network's org name, normalized (#184): what an Owner marks as expected. Cloudflare
        // sets it from the IP, so the caller does not choose it.
        network: name,
        expectedNetwork: expected,
        // The kind of key used (#154), an enum: `secret` (sb_secret_) or `jwt` (the legacy key).
        apiKeyKind: event.apiKeyKind,
        method: event.method,
        table: safeIdentifier(tableFromPath(event.path)),
        status: event.status,
      },
    });
  }

  ctx.networks.learn(ctx.scope, learned);
  // The first poll that learns a name seeds the name memory; until then names are learned silently.
  if (learnedNames.size > 0) ctx.networks.learnNames(ctx.scope, learnedNames);
  return findings;
}
