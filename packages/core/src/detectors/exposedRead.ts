import { effectiveRole, rowsReturned, type EdgeEvent } from "../logs/event.js";
import { tableFromPath } from "../postgrest/query.js";
import { classifyCaller, classifyNetwork, type CallerClass, type NetworkType } from "../network/classify.js";
import type { AnonReadable } from "../posture/findings.js";
import { safeIdentifier, type Finding, type Severity } from "./finding.js";

// Anon reads of exposed tables (issue #132): the anon key reads a table the posture scan shows
// readable by anon (RLS off with an anon SELECT grant, or a permissive policy that lets anon read
// every row). Baseline-free: posture says the table is open, the logs say someone is reading it.
// The rollup SQL fetches only anon GET/HEAD requests on these tables (logs/sql.ts).

// Rows in one poll from one network and caller class that read as a dump, not a page view.
export const BULK_READ_ROWS = 1000;

const READ_METHODS = new Set(["GET", "HEAD"]);

interface Group {
  table: string;
  posture: AnonReadable;
  asn: number | null;
  callerClass: CallerClass;
  networkType: NetworkType;
  hits: number;
  rows: number | null;
  firstSeen: string;
  lastSeen: string;
}

function severityOf(posture: Severity, rows: number): Severity {
  if (posture === "critical") return rows >= BULK_READ_ROWS ? "critical" : rows > 0 ? "high" : "low";
  return rows >= BULK_READ_ROWS ? "medium" : "low";
}

// One finding per table, network (ASN) and caller class in this poll. Rejected requests (4xx/5xx)
// read nothing and raise nothing.
export function detectExposedReads(events: EdgeEvent[], anonReadable: ReadonlyMap<string, AnonReadable>): Finding[] {
  if (anonReadable.size === 0) return [];
  const groups = new Map<string, Group>();

  for (const event of events) {
    if (effectiveRole(event) !== "anon" || !READ_METHODS.has(event.method)) continue;
    if (event.status !== null && event.status >= 400) continue;
    const table = safeIdentifier(tableFromPath(event.path));
    const posture = table === null ? undefined : anonReadable.get(table);
    if (table === null || !posture) continue;

    const { callerClass } = classifyCaller(event.userAgent, event.clientInfo);
    const networkType = classifyNetwork(event.asn, event.asOrganization);
    const key = `${table}|${event.asn ?? "unknown"}|${callerClass}`;
    const perRequest = rowsReturned(event.contentRange);
    const rows = perRequest === null ? null : perRequest * event.hits;
    const g = groups.get(key);
    if (!g) {
      groups.set(key, {
        table, posture, asn: event.asn, callerClass, networkType, hits: event.hits, rows,
        firstSeen: event.firstSeen, lastSeen: event.lastSeen,
      });
      continue;
    }
    g.hits += event.hits;
    if (rows !== null) g.rows = (g.rows ?? 0) + rows;
    if (event.firstSeen < g.firstSeen) g.firstSeen = event.firstSeen;
    if (event.lastSeen > g.lastSeen) g.lastSeen = event.lastSeen;
  }

  return [...groups.values()].map((g) => {
    const rows = g.rows ?? 0;
    const signals = ["exposed_table_read"];
    if (rows > 0) signals.push("rows_returned");
    if (rows >= BULK_READ_ROWS) signals.push("bulk_read");
    return {
      detector: "exposed_read",
      severity: severityOf(g.posture.severity, rows),
      actor: `anon:asn:${g.asn ?? "unknown"}`,
      signals,
      firstSeen: g.firstSeen,
      lastSeen: g.lastSeen,
      hits: g.hits,
      evidence: {
        table: g.table,
        postureCheck: g.posture.check,
        postureSeverity: g.posture.severity,
        rowsReturned: g.rows,
        outcome: g.rows === null ? "unknown" : rows > 0 ? "rows_returned" : "empty",
        asn: g.asn,
        callerClass: g.callerClass,
        networkType: g.networkType,
      },
    } satisfies Finding;
  });
}
