import { effectiveRole, type EdgeEvent } from "../logs/event.js";
import { tableFromPath } from "../postgrest/query.js";
import { classifyCaller, classifyNetwork } from "../network/classify.js";
import { scopeKey, type ProjectScope } from "../tenancy/scope.js";
import { maxSeverity, safeIdentifier, type Finding, type Severity } from "./finding.js";

// Detector 4: the service-role key used from a browser, a mobile app, a non-hosting network,
// or a hosting network the project has not used before.
// Baseline-free: the caller and network checks need no history. Only `new_network` needs
// the seen-set below, which is light state, not a statistical baseline.

// Hosting ASNs each project's service key has been seen from, keyed by tenant + Supahound
// project ID. Never by Supabase ref: two tenants can watch the same Supabase project.
// The poller loads it from and saves it to the database around each poll.
export class ServiceRoleNetworks {
  private readonly seen = new Map<string, Set<number>>();

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
}

export interface ServiceRoleContext {
  scope: ProjectScope;
  networks: ServiceRoleNetworks;
  // Networks the customer declared as their own servers. Silences network signals only:
  // a browser holding the service key is a leak wherever it sits.
  expectedAsns?: ReadonlySet<number>;
}

const SIGNAL_SEVERITY = {
  browser_caller: "critical",
  mobile_app_caller: "critical",
  non_hosting_network: "high",
  manual_tool: "medium",
  new_network: "medium",
} as const satisfies Record<string, Severity>;

type Signal = keyof typeof SIGNAL_SEVERITY;

// Processes one poll's events. On a project's first poll, hosting networks are learned
// without a `new_network` signal; every other signal fires from the first poll.
export function detectServiceRoleMisuse(events: EdgeEvent[], ctx: ServiceRoleContext): Finding[] {
  const seeding = !ctx.networks.isSeeded(ctx.scope);
  const findings: Finding[] = [];
  const learned = new Set<number>();

  for (const event of events) {
    if (effectiveRole(event) !== "service_role") continue;

    const caller = classifyCaller(event.userAgent, event.clientInfo);
    const network = classifyNetwork(event.asn, event.asOrganization);
    const expected = event.asn !== null && (ctx.expectedAsns?.has(event.asn) ?? false);
    const signals: Signal[] = [];

    if (caller.callerClass === "browser") signals.push("browser_caller");
    if (caller.callerClass === "mobile_app") signals.push("mobile_app_caller");
    if (caller.callerClass === "manual_tool") signals.push("manual_tool");
    if (!expected && network === "other") signals.push("non_hosting_network");
    if (!expected && !seeding && network === "hosting" && event.asn !== null && !ctx.networks.has(ctx.scope, event.asn)) {
      signals.push("new_network");
    }

    // Learn only hosting networks seen from server-like callers, so a leaked key used from
    // a cloud VM by a browser automation tool does not teach itself in.
    if (network === "hosting" && event.asn !== null && (caller.callerClass === "server" || caller.callerClass === "unknown")) {
      learned.add(event.asn);
    }

    if (signals.length === 0) continue;
    findings.push({
      detector: "service_role_misuse",
      severity: maxSeverity(signals.map((s) => SIGNAL_SEVERITY[s])),
      actor: `service_role:asn:${event.asn ?? "unknown"}`,
      signals,
      firstSeen: event.firstSeen,
      lastSeen: event.lastSeen,
      hits: event.hits,
      evidence: {
        callerClass: caller.callerClass,
        sdk: caller.sdk,
        networkType: network,
        asn: event.asn,
        expectedNetwork: expected,
        method: event.method,
        table: safeIdentifier(tableFromPath(event.path)),
        status: event.status,
      },
    });
  }

  ctx.networks.learn(ctx.scope, learned);
  return findings;
}
