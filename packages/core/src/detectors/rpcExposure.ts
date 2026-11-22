import { effectiveRole, rowsReturned, type EdgeEvent } from "../logs/event.js";
import { rpcFunctionFromPath } from "../postgrest/query.js";
import { classifyCaller, classifyNetwork, type CallerClass, type NetworkType } from "../network/classify.js";
import type { DefinerExposure } from "../posture/findings.js";
import { safeIdentifier, type Finding, type Severity } from "./finding.js";

// Anon calls to exposed SECURITY DEFINER functions (issue #131): the anon key calls an RPC function
// that the posture scan shows runs as its owner (bypassing RLS) and that anon may execute.
// Baseline-free: posture says the function is open, the logs say someone is calling it. The rollup
// SQL fetches only anon calls to these functions (logs/sql.ts). Request bodies, and so RPC
// arguments sent as JSON, are not in edge logs: the finding says which function, never with what.

// Calls in one poll from one network and caller class that read as automation, not an app.
export const RPC_BURST_HITS = 100;

// The signals this detector emits; each has a rule in rules.ts.
export const RPC_EXPOSURE_SIGNALS = ["definer_rpc_call", "rpc_burst"] as const;
export type RpcExposureSignal = (typeof RPC_EXPOSURE_SIGNALS)[number];

interface Group {
  fn: string;
  posture: DefinerExposure;
  asn: number | null;
  callerClass: CallerClass;
  networkType: NetworkType;
  hits: number;
  rows: number | null;
  methods: Set<string>;
  firstSeen: string;
  lastSeen: string;
}

// One finding per function, network (ASN) and caller class in this poll. Rejected calls (4xx/5xx)
// ran nothing and raise nothing.
export function detectRpcExposure(events: EdgeEvent[], definers: ReadonlyMap<string, DefinerExposure>): Finding[] {
  if (definers.size === 0) return [];
  const groups = new Map<string, Group>();

  for (const event of events) {
    if (effectiveRole(event) !== "anon") continue;
    if (event.status !== null && event.status >= 400) continue;
    const fn = safeIdentifier(rpcFunctionFromPath(event.path));
    const posture = fn === null ? undefined : definers.get(fn);
    if (fn === null || !posture) continue;

    const { callerClass } = classifyCaller(event.userAgent, event.clientInfo);
    const networkType = classifyNetwork(event.asn, event.asOrganization);
    const key = `${fn}|${event.asn ?? "unknown"}|${callerClass}`;
    const perCall = rowsReturned(event.contentRange);
    const rows = perCall === null ? null : perCall * event.hits;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        fn, posture, asn: event.asn, callerClass, networkType, hits: event.hits, rows,
        methods: new Set([event.method]), firstSeen: event.firstSeen, lastSeen: event.lastSeen,
      });
      continue;
    }
    g.hits += event.hits;
    g.methods.add(event.method);
    if (rows !== null) g.rows = (g.rows ?? 0) + rows;
    if (event.firstSeen < g.firstSeen) g.firstSeen = event.firstSeen;
    if (event.lastSeen > g.lastSeen) g.lastSeen = event.lastSeen;
  }

  return [...groups.values()].map((g) => {
    const signals: RpcExposureSignal[] = ["definer_rpc_call"];
    let severity: Severity = "medium";
    if (g.hits >= RPC_BURST_HITS) {
      signals.push("rpc_burst");
      severity = "high";
    }
    return {
      detector: "rpc_exposure",
      severity,
      actor: `anon:asn:${g.asn ?? "unknown"}`,
      signals,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      hits: g.hits,
      evidence: {
        function: g.fn,
        postureCheck: g.posture.check,
        postureSeverity: g.posture.severity,
        // One method, or "mixed" when the group saw several (GET and POST both call a function).
        method: g.methods.size === 1 ? [...g.methods][0]! : "mixed",
        rowsReturned: g.rows,
        asn: g.asn,
        callerClass: g.callerClass,
        networkType: g.networkType,
      },
    } satisfies Finding;
  });
}
