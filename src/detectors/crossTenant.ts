import { effectiveRole, rowsReturned, type EdgeEvent } from "../logs/event.js";
import { parseRequest, type Condition } from "../postgrest/query.js";
import type { OwnershipMap } from "../ownership/ownership.js";
import { fingerprint, maxSeverity, type Finding, type Severity } from "./finding.js";

// Detector 2: a signed-in user filters an ownership column by someone else's ID.
// Baseline-free: the caller's JWT subject is the expected value, so it alerts from day one.

export type MismatchKind =
  | "other_owner" // user_id=eq.B sent by A
  | "all_but_self" // user_id=neq.A: every tenant except the caller
  | "excludes_other" // user_id=neq.B: every tenant except one
  | "pattern" // like / ilike / match on an owner column
  | "range" // gt / lt sweeps over owner IDs
  | "any_owner"; // user_id=not.is.null

export type Outcome = "rejected" | "empty" | "rows_returned" | "unknown";

const RANGE_OPS = new Set(["gt", "gte", "lt", "lte"]);
const PATTERN_OPS = new Set(["like", "ilike", "match", "imatch"]);
const BROAD_KINDS = new Set<MismatchKind>(["all_but_self", "excludes_other", "pattern", "range", "any_owner"]);

function sameId(a: string, b: string): boolean {
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

interface Classified {
  kind: MismatchKind | "self";
  foreign: string[];
}

function classify(cond: Condition, subject: string): Classified | null {
  const foreign = cond.values.filter((v) => !sameId(v, subject));
  const hasSelf = foreign.length < cond.values.length;
  const { op, negated } = cond;

  if ((op === "eq" || op === "in") && !negated) {
    return foreign.length > 0 ? { kind: "other_owner", foreign } : { kind: "self", foreign };
  }
  if (op === "neq" || ((op === "eq" || op === "in") && negated)) {
    // neq.X is "everyone but X"; not.neq.X is eq.X again.
    if (op === "neq" && negated) {
      return foreign.length > 0 ? { kind: "other_owner", foreign } : { kind: "self", foreign };
    }
    return { kind: hasSelf ? "all_but_self" : "excludes_other", foreign };
  }
  if (PATTERN_OPS.has(op)) return { kind: "pattern", foreign: [] };
  if (RANGE_OPS.has(op)) return { kind: "range", foreign: [] };
  if (op === "is" && negated && cond.values[0]?.toLowerCase() === "null") return { kind: "any_owner", foreign: [] };
  return null;
}

export function outcomeOf(event: EdgeEvent): Outcome {
  if (event.status !== null && event.status >= 400) return "rejected";
  const rows = rowsReturned(event.contentRange);
  if (rows === null) return "unknown";
  return rows > 0 ? "rows_returned" : "empty";
}

export function detectCrossTenant(event: EdgeEvent, ownership: OwnershipMap): Finding | null {
  const subject = event.jwtSubject;
  const role = effectiveRole(event);
  // Service role bypasses RLS by design (detector 4 covers it); anon has no subject.
  if (subject === null || role === "service_role" || role === "anon") return null;

  const parsed = parseRequest(event.path, event.search);
  if (parsed.table === null) return null;

  const mismatches: { table: string; column: string; kind: MismatchKind; foreign: string[] }[] = [];
  const pinnedTables = new Set<string>();

  for (const cond of parsed.conditions) {
    const table = cond.embed ?? parsed.table;
    if (!ownership[table]?.includes(cond.column)) continue;
    const c = classify(cond, subject);
    if (c === null) continue;
    if (c.kind === "self") {
      if (cond.conjunctive) pinnedTables.add(table);
      continue;
    }
    mismatches.push({ table, column: cond.column, kind: c.kind, foreign: c.foreign });
  }

  // On a table with several owner columns (sender_id, receiver_id), filtering by the other
  // party is normal once one owner column is pinned to the caller.
  const live = mismatches.filter((m) => !((ownership[m.table]?.length ?? 0) > 1 && pinnedTables.has(m.table)));
  if (live.length === 0) return null;

  const severities: Severity[] = live.map((m) => {
    const multiParty = (ownership[m.table]?.length ?? 0) > 1;
    if (!multiParty) return "critical";
    return BROAD_KINDS.has(m.kind) ? "high" : "medium";
  });
  const first = live[0]!;
  const foreign = [...new Set(live.flatMap((m) => m.foreign.map((v) => v.toLowerCase())))];
  const outcome = outcomeOf(event);

  return {
    detector: "cross_tenant",
    severity: maxSeverity(severities),
    actor: `user:${subject}`,
    signals: [...new Set(live.map((m) => m.kind))],
    firstSeen: event.firstSeen,
    lastSeen: event.lastSeen,
    hits: event.hits,
    evidence: {
      table: first.table,
      column: first.column,
      tableShape: (ownership[first.table]?.length ?? 0) > 1 ? "multi_party" : "single_owner",
      method: event.method,
      status: event.status,
      outcome,
      rowsReturned: rowsReturned(event.contentRange),
      foreignIdCount: foreign.length,
      foreignIdFingerprint: foreign.length > 0 ? fingerprint(foreign.sort().join(",")) : null,
      unparsedFilters: parsed.unparsed.length,
    },
  };
}
