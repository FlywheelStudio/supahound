// Ownership per table and per command: the columns RLS forces to equal the caller's user ID.
// Taken from policy expressions, not column names, so `receiver_id` on a messages table is an
// ownership column only when a policy says so, and a public-read table (SELECT USING (true))
// has no read ownership even when its UPDATE policy is owner-only.

export type Command = "SELECT" | "UPDATE" | "DELETE";
export const COMMANDS: readonly Command[] = ["SELECT", "UPDATE", "DELETE"];

// table -> command -> owner columns. A missing command means RLS does not scope it to an owner.
export type OwnershipMap = Record<string, Partial<Record<Command, string[]>>>;

// One row of POLICIES_SQL. Query-string filters only matter for rows that already exist, so
// INSERT policies and with_check are not read.
export interface PolicyRow {
  schemaname: string;
  tablename: string;
  permissive?: string | null;
  roles?: string[] | string | null;
  cmd?: string | null;
  qual: string | null;
  with_check?: string | null;
}

export const POLICIES_SQL = `SELECT schemaname, tablename, permissive, roles, cmd, qual, with_check
FROM pg_catalog.pg_policies
WHERE schemaname = 'public'`;

const UID = "__UID__";
const IDENT = String.raw`[a-z_][a-z0-9_$]*`;
const QUALIFIED = String.raw`(?:"?${IDENT}"?\.)?"?(${IDENT})"?`;

// Reduces the deparsed policy text to a form where the caller's ID is the token __UID__.
function normalize(expr: string): string {
  let s = expr.toLowerCase();
  // Drop casts: ::text, ::uuid, ::character varying, ::text[]
  s = s.replace(/::\s*"?[a-z_]+"?(?:\s+varying)?(?:\[\])?/g, "");
  // Initplan wrappers that Supabase's advisor recommends: (select auth.uid() as uid)
  s = s.replace(/\(\s*select\s+\(?\s*auth\.uid\(\)\s*\)?\s+as\s+\w+\s*\)/g, UID);
  s = s.replace(/\(\s*select\s+\(?\s*auth\.jwt\(\)\s*->>\s*'sub'\s*\)?\s+as\s+\w+\s*\)/g, UID);
  s = s.replace(/auth\.uid\(\)/g, UID);
  s = s.replace(/auth\.jwt\(\)\s*->>\s*'sub'/g, UID);
  // Strip parentheses around a lone token until stable: ((__UID__)) -> __UID__
  let prev;
  do {
    prev = s;
    s = s.replace(new RegExp(String.raw`\(\s*(${UID}|(?:"?${IDENT}"?\.)?"?${IDENT}"?)\s*\)`, "g"), " $1 ");
  } while (s !== prev);
  return s;
}

// True when position `index` sits inside a parenthesised subquery (a group that opens with SELECT).
function insideSubquery(s: string, index: number): boolean {
  const stack: boolean[] = [];
  for (let i = 0; i < index; i++) {
    if (s[i] === "(") stack.push(/^\s*select\b/.test(s.slice(i + 1)));
    else if (s[i] === ")") stack.pop();
  }
  return stack.includes(true);
}

function directColumns(s: string, table?: string): string[] {
  const found = new Set<string>();
  const patterns = [
    new RegExp(String.raw`${UID}\s*=\s*(${QUALIFIED})`, "g"),
    new RegExp(String.raw`(${QUALIFIED})\s*=\s*${UID}`, "g"),
  ];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      if (insideSubquery(s, m.index)) continue;
      const full = m[1]!.replace(/"/g, "");
      const qualifier = full.includes(".") ? full.split(".")[0] : null;
      if (qualifier && table && qualifier !== table.toLowerCase()) continue;
      found.add(m[2]!);
    }
  }
  return [...found];
}

// Every column compared directly to the caller's ID, outside any subquery, in any branch.
// `team_id IN (SELECT ... WHERE user_id = auth.uid())` yields nothing: membership is not ownership.
export function ownershipColumns(expr: string | null | undefined, table?: string): string[] {
  return expr ? directColumns(normalize(expr), table) : [];
}

function stripOuterParens(s: string): string {
  let t = s.trim();
  while (t.startsWith("(") && t.endsWith(")")) {
    let depth = 0;
    let wraps = true;
    for (let i = 0; i < t.length - 1; i++) {
      if (t[i] === "(") depth++;
      else if (t[i] === ")") depth--;
      if (depth === 0) {
        wraps = false;
        break;
      }
    }
    if (!wraps) break;
    t = t.slice(1, -1).trim();
  }
  return t;
}

function splitTopLevel(s: string, word: "or" | "and"): string[] {
  const parts: string[] = [];
  const re = new RegExp(String.raw`\s${word}\s`, "y");
  let depth = 0;
  let start = 0;
  for (let i = 0; i < s.length; i++) {
    if (s[i] === "(") depth++;
    else if (s[i] === ")") depth--;
    else if (depth === 0) {
      re.lastIndex = i;
      if (re.test(s)) {
        parts.push(s.slice(start, i));
        start = re.lastIndex;
        i = re.lastIndex - 1;
      }
    }
  }
  parts.push(s.slice(start));
  return parts;
}

function required(s: string, table?: string): string[] {
  const t = stripOuterParens(s);
  const ors = splitTopLevel(t, "or");
  if (ors.length > 1) {
    const branches = ors.map((b) => required(b, table));
    return branches.every((b) => b.length > 0) ? [...new Set(branches.flat())] : [];
  }
  const ands = splitTopLevel(t, "and");
  if (ands.length > 1) return [...new Set(ands.flatMap((b) => required(b, table)))];
  return directColumns(t, table);
}

// Columns a row must match to pass the expression: every OR branch needs an owner comparison.
// `(is_public = true) OR (auth.uid() = user_id)` requires nothing; `auth.uid() = sender_id OR
// auth.uid() = receiver_id` requires one of the two.
export function requiredOwnerColumns(expr: string | null | undefined, table?: string): string[] {
  return expr ? required(normalize(expr), table) : [];
}

function appliesToUsers(roles: PolicyRow["roles"]): boolean {
  if (roles === null || roles === undefined) return true;
  const list = Array.isArray(roles) ? roles : roles.replace(/[{}]/g, "").split(",");
  return list.some((r) => r.trim() === "authenticated" || r.trim() === "public");
}

function coversCommand(row: PolicyRow, command: Command): boolean {
  const cmd = (row.cmd ?? "ALL").toUpperCase();
  return cmd === "ALL" || cmd === "*" || cmd === command;
}

// A command is owner-scoped when RLS lets no row through without an owner match: every
// permissive policy requires one, or a restrictive policy does.
export function ownershipFromPolicies(rows: PolicyRow[]): OwnershipMap {
  const byTable = new Map<string, PolicyRow[]>();
  for (const row of rows) {
    if (row.schemaname !== "public" || !appliesToUsers(row.roles)) continue;
    byTable.set(row.tablename, [...(byTable.get(row.tablename) ?? []), row]);
  }

  const map: OwnershipMap = {};
  for (const [table, policies] of byTable) {
    for (const command of COMMANDS) {
      const applicable = policies.filter((p) => coversCommand(p, command));
      const restrictive = applicable.filter((p) => p.permissive?.toUpperCase() === "RESTRICTIVE");
      const permissive = applicable.filter((p) => p.permissive?.toUpperCase() !== "RESTRICTIVE");
      if (permissive.length === 0) continue; // RLS returns no rows at all

      const fromRestrictive = restrictive.flatMap((p) => requiredOwnerColumns(p.qual, table));
      const fromPermissive = permissive.map((p) => requiredOwnerColumns(p.qual, table));
      const columns = fromRestrictive.length > 0
        ? fromRestrictive
        : fromPermissive.every((c) => c.length > 0) ? fromPermissive.flat() : [];
      if (columns.length > 0) (map[table] ??= {})[command] = [...new Set(columns)].sort();
    }
  }
  return map;
}

// A hand-written {table: [columns]} map means owner-scoped for every command.
export function ownershipFromColumns(columns: Record<string, string[]>): OwnershipMap {
  return Object.fromEntries(
    Object.entries(columns).map(([table, cols]) => [
      table,
      Object.fromEntries(COMMANDS.map((c) => [c, [...cols].sort()])),
    ]),
  );
}

// PostgREST method -> the RLS command that filters existing rows. POST inserts new rows, so
// query-string filters do not select anything to cross into.
export function commandForMethod(method: string): Command | null {
  switch (method.toUpperCase()) {
    case "GET":
    case "HEAD":
      return "SELECT";
    case "PATCH":
    case "PUT":
      return "UPDATE";
    case "DELETE":
      return "DELETE";
    default:
      return null;
  }
}
