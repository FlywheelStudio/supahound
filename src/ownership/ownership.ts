// Ownership columns per table: the columns an RLS policy compares to the caller's user ID.
// Taken from policy expressions, not column names, so `receiver_id` on a messages table is
// an ownership column only when a policy says so.

export type OwnershipMap = Record<string, string[]>;

// One row of `SELECT schemaname, tablename, roles, cmd, qual, with_check FROM pg_policies`.
export interface PolicyRow {
  schemaname: string;
  tablename: string;
  roles?: string[] | string | null;
  cmd?: string | null;
  qual: string | null;
  with_check?: string | null;
}

export const POLICIES_SQL = `SELECT schemaname, tablename, roles, cmd, qual, with_check
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

// Columns compared directly to the caller's ID, outside any subquery.
// `team_id IN (SELECT ... WHERE user_id = auth.uid())` yields nothing: membership is not ownership.
export function ownershipColumns(expr: string | null | undefined, table?: string): string[] {
  if (!expr) return [];
  const s = normalize(expr);
  const found = new Set<string>();
  const patterns = [
    new RegExp(String.raw`${UID}\s*=\s*(${QUALIFIED})`, "g"),
    new RegExp(String.raw`(${QUALIFIED})\s*=\s*${UID}`, "g"),
  ];
  for (const re of patterns) {
    for (const m of s.matchAll(re)) {
      if (insideSubquery(s, m.index)) continue;
      const full = m[1]!.replace(/"/g, "");
      const column = m[2]!;
      const qualifier = full.includes(".") ? full.split(".")[0] : null;
      if (qualifier && table && qualifier !== table.toLowerCase()) continue;
      found.add(column);
    }
  }
  return [...found];
}

function appliesToUsers(roles: PolicyRow["roles"]): boolean {
  if (roles === null || roles === undefined) return true;
  const list = Array.isArray(roles) ? roles : roles.replace(/[{}]/g, "").split(",");
  return list.some((r) => r.trim() === "authenticated" || r.trim() === "public");
}

export function ownershipFromPolicies(rows: PolicyRow[]): OwnershipMap {
  const map: Record<string, Set<string>> = {};
  for (const row of rows) {
    if (row.schemaname !== "public" || !appliesToUsers(row.roles)) continue;
    const cols = [
      ...ownershipColumns(row.qual, row.tablename),
      ...ownershipColumns(row.with_check, row.tablename),
    ];
    if (cols.length === 0) continue;
    const set = (map[row.tablename] ??= new Set());
    for (const c of cols) set.add(c);
  }
  return Object.fromEntries(Object.entries(map).map(([t, s]) => [t, [...s].sort()]));
}
