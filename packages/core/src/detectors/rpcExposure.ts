import { effectiveRole, rowsReturned, type EdgeEvent } from "../logs/event.js";
import { rpcFunctionFromPath } from "../postgrest/query.js";
import { classifyCaller, classifyNetwork, type CallerClass, type NetworkType } from "../network/classify.js";
import type { DefinerExposure } from "../posture/findings.js";
import { safeIdentifier, type Finding, type Severity } from "./finding.js";

// Calls to exposed SECURITY DEFINER functions: the caller runs a function that the posture scan
// shows runs as its owner (bypassing RLS) and that the caller's role may execute.
//   - Anon (issue #131): the anon key calls a function anon may execute. The rollup SQL fetches
//     only anon calls to these functions (logs/sql.ts). Medium, or high in a burst.
//   - Authenticated (issue #157, decision 6 of #131): a signed-in user calls a function
//     authenticated may execute. The rollup already holds every REST call with a user subject.
//     Signed-in apps call their own functions all the time, so this is a record, not an alarm:
//     always low, whatever the count. Its actor is the function (`definer:fn:<name>`), not the
//     user: one incident per function while calls continue, never one per user, and it never
//     shares an incident with a user's other findings, so it never stacks into a page. Evidence
//     counts the distinct users; it names none.
// Baseline-free: posture says the function is open, the logs say someone is calling it. Request
// bodies, and so RPC arguments sent as JSON, are not in edge logs: the finding says which function,
// never with what.

// Calls in one poll from one network and caller class that read as automation, not an app. The
// default; each project sets its own between RPC_BURST_MIN and RPC_BURST_MAX (decision 045).
export const RPC_BURST_HITS = 100;
export const RPC_BURST_MIN = 10;
export const RPC_BURST_MAX = 10_000;

export function isRpcBurstHits(n: unknown): n is number {
  return typeof n === "number" && Number.isInteger(n) && n >= RPC_BURST_MIN && n <= RPC_BURST_MAX;
}

// The signals this detector emits; each has a rule in rules.ts.
export const RPC_EXPOSURE_SIGNALS = ["definer_rpc_call", "rpc_burst", "authenticated_definer_call"] as const;
export type RpcExposureSignal = (typeof RPC_EXPOSURE_SIGNALS)[number];

// The actor prefix of signed-in definer calls: kept apart from users' `user:` incidents.
export const DEFINER_ACTOR_PREFIX = "definer:fn:";

interface Group {
  role: "anon" | "authenticated";
  actor: string;
  fn: string;
  posture: DefinerExposure;
  asn: number | null;
  callerClass: CallerClass;
  networkType: NetworkType;
  hits: number;
  rows: number | null;
  methods: Set<string>;
  // Distinct user subjects, counted only; never stored.
  users: Set<string>;
  firstSeen: string;
  lastSeen: string;
}

// One finding per function, actor, network (ASN) and caller class in this poll. Rejected calls
// (4xx/5xx) ran nothing and raise nothing. burstHits is the project's paging threshold for anon
// calls (decision 045); an out-of-range value falls back to the default, so a bad setting never
// silences the burst.
export function detectRpcExposure(
  events: EdgeEvent[],
  definers: ReadonlyMap<string, DefinerExposure>,
  authenticatedDefiners: ReadonlyMap<string, DefinerExposure> = new Map(),
  burstHits: number = RPC_BURST_HITS,
): Finding[] {
  if (definers.size === 0 && authenticatedDefiners.size === 0) return [];
  const burst = isRpcBurstHits(burstHits) ? burstHits : RPC_BURST_HITS;
  const groups = new Map<string, Group>();

  for (const event of events) {
    const role = effectiveRole(event);
    if (role !== "anon" && role !== "authenticated") continue;
    if (event.status !== null && event.status >= 400) continue;
    const fn = safeIdentifier(rpcFunctionFromPath(event.path));
    const posture = fn === null ? undefined : (role === "anon" ? definers : authenticatedDefiners).get(fn);
    if (fn === null || !posture) continue;

    const actor = role === "anon" ? `anon:asn:${event.asn ?? "unknown"}` : `${DEFINER_ACTOR_PREFIX}${fn}`;
    const { callerClass } = classifyCaller(event.userAgent, event.clientInfo);
    const networkType = classifyNetwork(event.asn, event.asOrganization);
    const key = `${fn}|${actor}|${event.asn ?? "unknown"}|${callerClass}`;
    const perCall = rowsReturned(event.contentRange);
    const rows = perCall === null ? null : perCall * event.hits;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        role, actor, fn, posture, asn: event.asn, callerClass, networkType, hits: event.hits, rows,
        methods: new Set([event.method]), users: new Set(event.jwtSubject === null ? [] : [event.jwtSubject]),
        firstSeen: event.firstSeen, lastSeen: event.lastSeen,
      });
      continue;
    }
    if (event.jwtSubject !== null) g.users.add(event.jwtSubject);
    g.hits += event.hits;
    g.methods.add(event.method);
    if (rows !== null) g.rows = (g.rows ?? 0) + rows;
    if (event.firstSeen < g.firstSeen) g.firstSeen = event.firstSeen;
    if (event.lastSeen > g.lastSeen) g.lastSeen = event.lastSeen;
  }

  return [...groups.values()].map((g) => {
    const signals: RpcExposureSignal[] = [];
    let severity: Severity;
    if (g.role === "authenticated") {
      signals.push("authenticated_definer_call");
      severity = "low";
    } else {
      signals.push("definer_rpc_call");
      severity = "medium";
      if (g.hits >= burst) {
        signals.push("rpc_burst");
        severity = "high";
      }
    }
    return {
      detector: "rpc_exposure",
      severity,
      actor: g.actor,
      signals,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      hits: g.hits,
      evidence: {
        function: g.fn,
        role: g.role,
        postureCheck: g.posture.check,
        postureSeverity: g.posture.severity,
        // One method, or "mixed" when the group saw several (GET and POST both call a function).
        method: g.methods.size === 1 ? [...g.methods][0]! : "mixed",
        rowsReturned: g.rows,
        // Signed-in calls: how many users made them. Null for anon calls.
        users: g.role === "authenticated" ? g.users.size : null,
        // The project's paging threshold for this poll, a count (decision 045).
        burstThreshold: burst,
        asn: g.asn,
        callerClass: g.callerClass,
        networkType: g.networkType,
      },
    } satisfies Finding;
  });
}
