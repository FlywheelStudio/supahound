// Parses a PostgREST request (path + query string) into flat filter conditions.
// Grammar: https://postgrest.org/en/stable/references/api/tables_views.html#horizontal-filtering
//
// Each condition records two things the cross-tenant detector needs:
//   negated     - after applying every `not.` on the way down (De Morgan for groups)
//   conjunctive - true when the condition must hold for every row returned, i.e. it is not
//                 inside an `or` branch. Only conjunctive self-filters pin a request to its caller.

export const OPERATORS = new Set([
  "eq", "neq", "gt", "gte", "lt", "lte", "like", "ilike", "match", "imatch", "in", "is",
  "isdistinct", "fts", "plfts", "phfts", "wfts", "cs", "cd", "ov", "sl", "sr", "nxr", "nxl", "adj",
]);

const RESERVED = new Set(["select", "order", "limit", "offset", "on_conflict", "columns"]);

export interface Condition {
  // Embedded resource the column belongs to (`orders` in `orders.user_id=eq.1`), or null.
  embed: string | null;
  column: string;
  op: string;
  values: string[];
  negated: boolean;
  conjunctive: boolean;
}

export interface ParsedRequest {
  table: string | null;
  conditions: Condition[];
  // Filters the parser could not read. Kept so a caller can tell "no filter" from "unparsed".
  unparsed: string[];
}

export function tableFromPath(path: string): string | null {
  const m = /^\/rest\/v1\/([^/?#]+)\/?$/.exec(path);
  if (!m || m[1] === undefined) return null;
  const name = safeDecode(m[1]);
  return name === "rpc" ? null : name;
}

function safeDecode(s: string): string {
  try {
    return decodeURIComponent(s);
  } catch {
    return s;
  }
}

// URLSearchParams would turn "+" into a space; PostgREST does not, so split by hand.
function splitQuery(search: string): [string, string][] {
  const q = search.startsWith("?") ? search.slice(1) : search;
  if (q === "") return [];
  return q.split("&").filter(Boolean).map((part) => {
    const i = part.indexOf("=");
    return i === -1
      ? [safeDecode(part), ""]
      : [safeDecode(part.slice(0, i)), safeDecode(part.slice(i + 1))];
  });
}

// Splits on `sep` at depth 0, honouring (), {} and double-quoted strings.
function splitTopLevel(s: string, sep: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let quoted = false;
  let current = "";
  for (let i = 0; i < s.length; i++) {
    const ch = s[i]!;
    if (quoted) {
      current += ch;
      if (ch === "\\" && i + 1 < s.length) current += s[++i]!;
      else if (ch === '"') quoted = false;
      continue;
    }
    if (ch === '"') quoted = true;
    else if (ch === "(" || ch === "{") depth++;
    else if (ch === ")" || ch === "}") depth--;
    if (ch === sep && depth === 0) {
      out.push(current);
      current = "";
    } else {
      current += ch;
    }
  }
  out.push(current);
  return out;
}

function unquote(v: string): string {
  const t = v.trim();
  if (t.length >= 2 && t.startsWith('"') && t.endsWith('"')) {
    return t.slice(1, -1).replace(/\\(.)/g, "$1");
  }
  return t;
}

function listValues(raw: string): string[] {
  const inner = raw.trim().replace(/^[({]/, "").replace(/[)}]$/, "");
  if (inner === "") return [];
  return splitTopLevel(inner, ",").map(unquote);
}

interface OpValue {
  op: string;
  negated: boolean;
  values: string[];
}

// Reads "[not.]op[(any|all)].value" from dot-split tokens.
function readOpValue(tokens: string[]): OpValue | null {
  let i = 0;
  let negated = false;
  if (tokens[i] === "not") {
    negated = true;
    i++;
  }
  const opToken = tokens[i];
  if (opToken === undefined) return null;
  const m = /^([a-z]+)(?:\((any|all)\))?$/.exec(opToken);
  if (!m || !OPERATORS.has(m[1]!)) return null;
  const op = m[1]!;
  const raw = tokens.slice(i + 1).join(".");
  const isList = op === "in" || m[2] !== undefined;
  return { op, negated, values: isList ? listValues(raw) : [unquote(raw)] };
}

function splitColumn(path: string, embed: string | null): { embed: string | null; column: string } {
  const parts = path.split(".");
  const column = parts.pop()!;
  const prefix = parts.length > 0 ? parts.join(".") : null;
  return { embed: prefix ?? embed, column };
}

interface Walk {
  negate: boolean;
  conjunctive: boolean;
  embed: string | null;
}

function pushLeaf(out: ParsedRequest, columnPath: string, ov: OpValue, walk: Walk): void {
  out.conditions.push({
    ...splitColumn(columnPath, walk.embed),
    op: ov.op,
    values: ov.values,
    negated: walk.negate !== ov.negated,
    conjunctive: walk.conjunctive,
  });
}

// A logical group: kind is "and"/"or", `negatedGroup` from a `not.` prefix, body "(a,b,...)".
function walkGroup(out: ParsedRequest, kind: "and" | "or", negatedGroup: boolean, body: string, walk: Walk): void {
  const negate = walk.negate !== negatedGroup;
  const effective = negate ? (kind === "and" ? "or" : "and") : kind;
  const child: Walk = { negate, conjunctive: walk.conjunctive && effective === "and", embed: walk.embed };
  const trimmed = body.trim();
  if (!trimmed.startsWith("(") || !trimmed.endsWith(")")) {
    out.unparsed.push(body);
    return;
  }
  for (const part of splitTopLevel(trimmed.slice(1, -1), ",")) walkCondition(out, part.trim(), child);
}

// One item inside a logical group: "col.op.value", "or(...)", "not.and(...)".
function walkCondition(out: ParsedRequest, text: string, walk: Walk): void {
  const group = /^(not\.)?(and|or)(\(.*\))$/s.exec(text);
  if (group) {
    walkGroup(out, group[2] as "and" | "or", group[1] !== undefined, group[3]!, walk);
    return;
  }
  const tokens = splitTopLevel(text, ".");
  for (let i = 1; i < tokens.length; i++) {
    const ov = readOpValue(tokens.slice(i));
    if (ov) {
      pushLeaf(out, tokens.slice(0, i).join("."), ov, walk);
      return;
    }
  }
  out.unparsed.push(text);
}

export function parseRequest(path: string, search: string): ParsedRequest {
  const out: ParsedRequest = { table: tableFromPath(path), conditions: [], unparsed: [] };
  const root: Walk = { negate: false, conjunctive: true, embed: null };
  for (const [key, value] of splitQuery(search)) {
    const parts = key.split(".");
    const last = parts[parts.length - 1]!;
    if (RESERVED.has(last)) continue;

    // Logical keys: or, and, not.or, orders.or, orders.not.and
    if (last === "or" || last === "and") {
      const negatedGroup = parts[parts.length - 2] === "not";
      const embedParts = parts.slice(0, negatedGroup ? -2 : -1);
      const embed = embedParts.length > 0 ? embedParts.join(".") : null;
      walkGroup(out, last, negatedGroup, value, { ...root, embed });
      continue;
    }

    const ov = readOpValue(splitTopLevel(value, "."));
    if (ov) pushLeaf(out, key, ov, root);
    else out.unparsed.push(`${key}=${value}`);
  }
  return out;
}
