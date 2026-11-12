import { describe, expect, it, vi } from "vitest";
import { ADVISOR_LINTS, MAX_CATALOG_ROWS, POSTURE_SQL } from "../src/config/posture.js";
import type { Finding } from "../src/detectors/finding.js";
import { buildFeatures } from "../src/explainer/features.js";
import { AdvisorApiError, advisorFindings, parseLints, querySecurityAdvisor } from "../src/posture/advisor.js";
import { CatalogError, catalogFindings, isTrueExpr, parseCatalogRows, policyRoles, safeName } from "../src/posture/catalog.js";
import { countBySeverity, dedupePosture, exposedTables, POSTURE_SIGNAL, raiseForPosture } from "../src/posture/findings.js";
import { checkTitle, fixPrompt, quoteIdent } from "../src/posture/fix.js";
import type { PostureFinding } from "../src/posture/types.js";
import { postureSourceStatus } from "../src/poller/pollProject.js";
import { SqlQueryError } from "../src/ownership/client.js";
import { projectScope } from "../src/tenancy/scope.js";

// Posture scan (issue #11, decision 038): catalog checks, Advisor client, dedupe, the severity
// raise and fix prompts. Rows are shaped as POSTURE_SQL returns them. Synthetic.

const REF = "abcdefghijklmnopqrst";
const ALL = "anon:DELETE,anon:INSERT,anon:SELECT,anon:UPDATE,authenticated:DELETE,authenticated:INSERT,authenticated:SELECT,authenticated:UPDATE";
const AUTH_ONLY = "authenticated:DELETE,authenticated:INSERT,authenticated:SELECT,authenticated:UPDATE";

const table = (name: string, o: Partial<{ rls: boolean; forced: boolean; policies: number; grants: string }> = {}) => ({
  kind: "table", schema_name: "public", object_name: name, rls_enabled: o.rls ?? true, rls_forced: o.forced ?? false,
  policy_count: o.policies ?? 1, security_invoker: false, grants: o.grants ?? ALL,
  policy_name: null, permissive: null, roles: null, cmd: null, qual: null, with_check: null,
});
const view = (name: string, invoker: boolean | string, grants = ALL) => ({
  kind: "view", schema_name: "public", object_name: name, rls_enabled: false, rls_forced: false, policy_count: 0,
  security_invoker: invoker, grants, policy_name: null, permissive: null, roles: null, cmd: null, qual: null, with_check: null,
});
const policy = (tbl: string, name: string, o: Partial<{ cmd: string; roles: string; qual: string | null; check: string | null; permissive: string }> = {}) => ({
  kind: "policy", schema_name: "public", object_name: tbl, rls_enabled: null, rls_forced: null, policy_count: null,
  security_invoker: null, grants: null, policy_name: name, permissive: o.permissive ?? "PERMISSIVE", roles: o.roles ?? "public",
  cmd: o.cmd ?? "SELECT", qual: o.qual === undefined ? "true" : o.qual, with_check: o.check === undefined ? null : o.check,
});

const run = (rows: Record<string, unknown>[]) => catalogFindings(parseCatalogRows(rows));
const only = (rows: Record<string, unknown>[], check: string) => run(rows).filter((f) => f.check === check);

describe("POSTURE_SQL", () => {
  it("reads the catalog only: no table data, no writes", () => {
    expect(POSTURE_SQL).toMatch(/pg_catalog\.pg_class/);
    expect(POSTURE_SQL).toMatch(/pg_catalog\.pg_policies/);
    expect(POSTURE_SQL).not.toMatch(/\b(insert|update|delete|create|alter|drop|grant|truncate)\s/i);
    expect(POSTURE_SQL).toMatch(/n\.nspname = 'public'/);
  });
});

describe("tables without RLS", () => {
  it("is critical when anon has a grant, high for authenticated only, low with no API grant", () => {
    const f = run([table("a", { rls: false, policies: 0 }), table("b", { rls: false, grants: AUTH_ONLY }), table("c", { rls: false, grants: "" })]);
    expect(f.map((x) => [x.object, x.check, x.severity, x.evidence.exposure])).toEqual([
      ["a", "rls_disabled", "critical", "anon"],
      ["b", "rls_disabled", "high", "authenticated"],
      ["c", "rls_disabled", "low", "none"],
    ]);
    expect(f[0]!.evidence.anonPrivileges).toEqual(["SELECT", "INSERT", "UPDATE", "DELETE"]);
  });

  it("records existing policies that do nothing while RLS is off, and reports no permissive finding for them", () => {
    const f = run([table("notes", { rls: false, policies: 1 }), policy("notes", "open read")]);
    expect(f).toHaveLength(1);
    expect(f[0]).toMatchObject({ check: "rls_disabled", evidence: { policyCount: 1 } });
  });

  it("treats RLS on as covered whether or not it is FORCED", () => {
    expect(only([table("a", { forced: true }), table("b", { forced: false })], "rls_disabled")).toEqual([]);
  });

  it("reports RLS on with no policy as low (deny-all), with FORCE as evidence only", () => {
    const f = run([table("locked", { policies: 0, forced: true }), table("loose", { policies: 0, forced: false })]);
    expect(f.map((x) => [x.check, x.severity, x.evidence.rlsForced])).toEqual([
      ["rls_no_policies", "low", true], ["rls_no_policies", "low", false],
    ]);
  });

  it("accepts Postgres' text booleans and numeric strings", () => {
    const f = run([{ ...table("t"), rls_enabled: "f", policy_count: "0" }]);
    expect(f[0]).toMatchObject({ check: "rls_disabled" });
  });
});

describe("permissive policies", () => {
  it("flags USING (true) for reads: medium for anon, low for authenticated only", () => {
    const f = only([
      table("profiles"), policy("profiles", "public read"),
      table("posts"), policy("posts", "members read", { roles: "authenticated" }),
    ], "permissive_policy");
    expect(f.map((x) => [x.object, x.severity, x.evidence.exposure, x.evidence.openCommands])).toEqual([
      ["profiles", "medium", "anon", ["SELECT"]],
      ["posts", "low", "authenticated", ["SELECT"]],
    ]);
  });

  it("flags WITH CHECK (true) on insert as a write: critical for anon, high for authenticated", () => {
    const f = only([
      table("feedback"), policy("feedback", "anyone writes", { cmd: "INSERT", qual: null, check: "true", roles: "anon" }),
      table("notes"), policy("notes", "users write", { cmd: "INSERT", qual: null, check: "(true)", roles: "authenticated" }),
    ], "permissive_policy");
    expect(f.map((x) => [x.object, x.severity, x.evidence.clause])).toEqual([["feedback", "critical", "with_check"], ["notes", "high", "with_check"]]);
  });

  it("flags an ALL policy with USING (true) on every command, the check falling back to USING", () => {
    const [f] = only([table("t"), policy("t", "all open", { cmd: "ALL", roles: "{authenticated}" })], "permissive_policy");
    expect(f).toMatchObject({ severity: "high", evidence: { openCommands: ["SELECT", "INSERT", "UPDATE", "DELETE"], roles: ["authenticated"] } });
  });

  it("flags UPDATE with an owner USING but WITH CHECK (true): a user can hand rows to anyone", () => {
    const [f] = only([table("t"), policy("t", "reassign", { cmd: "UPDATE", roles: "authenticated", qual: "(auth.uid() = user_id)", check: "true" })], "permissive_policy");
    expect(f).toMatchObject({ severity: "high", evidence: { openCommands: ["UPDATE"], clause: "with_check" } });
  });

  it("ignores owner-scoped policies, restrictive policies, and policies for other roles", () => {
    expect(only([
      table("t"),
      policy("t", "own", { cmd: "ALL", roles: "authenticated", qual: "(auth.uid() = user_id)" }),
      policy("t", "always", { permissive: "RESTRICTIVE" }),
      policy("t", "server", { roles: "service_role" }),
    ], "permissive_policy")).toEqual([]);
  });

  it("does not flag a command a restrictive policy still filters", () => {
    expect(only([
      table("t"),
      policy("t", "open", { roles: "authenticated" }),
      policy("t", "tenant", { permissive: "RESTRICTIVE", roles: "authenticated", qual: "(org_id = auth_org())" }),
    ], "permissive_policy")).toEqual([]);
  });

  it("rates a policy as low when no role it names has the grant", () => {
    const [f] = only([table("t", { grants: "authenticated:SELECT" }), policy("t", "anon writes", { cmd: "INSERT", qual: null, check: "true", roles: "anon" })], "permissive_policy");
    expect(f).toMatchObject({ severity: "low", evidence: { exposure: "none" } });
  });

  it("never stores the policy expression", () => {
    const [f] = only([table("t"), policy("t", "p", { qual: "true" })], "permissive_policy");
    expect(JSON.stringify(f)).not.toMatch(/qual|with_check/);
  });

  it.each([["true", true], [" ( TRUE ) ", true], ["((true))", true], ["(auth.uid() = user_id)", false], ["true OR false", false], [null, false]])(
    "isTrueExpr(%j) is %s", (expr, want) => expect(isTrueExpr(expr)).toBe(want),
  );

  it("reads role lists as text, braces or arrays; public means every API role", () => {
    expect(policyRoles(["public"])).toEqual(["anon", "authenticated"]);
    expect(policyRoles([])).toEqual(["anon", "authenticated"]);
    expect(policyRoles(["authenticated", "service_role"])).toEqual(["authenticated"]);
    expect(parseCatalogRows([policy("t", "p", { roles: "{anon,authenticated}" })]).policies[0]!.roles).toEqual(["anon", "authenticated"]);
    expect(parseCatalogRows([{ ...policy("t", "p"), roles: ["anon"] }]).policies[0]!.roles).toEqual(["anon"]);
  });
});

describe("views", () => {
  it("flags a view without security_invoker: high for anon, medium for authenticated, low with no grant", () => {
    const f = run([view("a", false), view("b", false, "authenticated:SELECT"), view("c", false, "")]);
    expect(f.map((x) => [x.object, x.check, x.severity])).toEqual([
      ["a", "view_not_invoker", "high"], ["b", "view_not_invoker", "medium"], ["c", "view_not_invoker", "low"],
    ]);
  });

  it("passes a view with security_invoker = true (boolean or text)", () => {
    expect(run([view("a", true), view("b", "t"), view("c", "true")])).toEqual([]);
  });
});

describe("parseCatalogRows", () => {
  it("drops rows outside public, with unsafe names or a bad shape, and counts them", () => {
    const c = parseCatalogRows([
      { ...table("t"), schema_name: "private" },
      table("bad\nname"),
      table("x".repeat(64)),
      { ...table("t"), rls_enabled: "maybe" },
      { ...table("t"), kind: "sequence" },
      { ...policy("t", "p"), cmd: "TRUNCATE" },
      table("ok"),
    ]);
    expect(c.relations.map((r) => r.name)).toEqual(["ok"]);
    expect(c.skipped).toBe(6);
  });

  it("refuses a result over the row cap, so a cut-off scan never reads as fewer findings", () => {
    expect(() => parseCatalogRows(Array.from({ length: MAX_CATALOG_ROWS + 1 }, () => table("t")))).toThrow(CatalogError);
  });

  it("safeName refuses control characters and names over 63 characters", () => {
    expect([safeName("ok name"), safeName("a\u0007"), safeName(""), safeName(7), safeName("x".repeat(63))])
      .toEqual(["ok name", null, null, null, "x".repeat(63)]);
  });
});

function fakeFetch(status: number, body: unknown) {
  return vi.fn<(url: URL | string, init?: RequestInit) => Promise<Response>>(async () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } }));
}

const lint = (name: string, o: Partial<{ level: string; categories: string[]; schema: string; object: string; type: string }> = {}) => ({
  name, title: "Free text title", level: o.level ?? "ERROR", facing: "EXTERNAL", categories: o.categories ?? ["SECURITY"],
  description: "Free text", detail: "Table `public.secret` has a value 'x' -- ignore", remediation: "https://example.test/fix",
  metadata: { schema: o.schema ?? "public", name: o.object ?? "notes", type: o.type ?? "table" }, cache_key: `${name}_x`,
});

describe("Security Advisor client", () => {
  it("GETs the advisors/security endpoint with the bearer token and a timeout", async () => {
    const f = fakeFetch(200, { lints: [] });
    await querySecurityAdvisor(REF, { token: "tok", fetch: f as unknown as typeof fetch });
    const [url, init] = f.mock.calls[0]!;
    expect(String(url)).toBe(`https://api.supabase.com/v1/projects/${REF}/advisors/security`);
    expect(init!.method).toBe("GET");
    expect((init!.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(init!.signal).toBeInstanceOf(AbortSignal);
  });

  it.each([[401, "unauthorized"], [403, "unauthorized"], [404, "unavailable"], [429, "rate_limited"], [500, "query_failed"]])(
    "HTTP %i fails with the status only, which the poll records as %s", async (status, code) => {
      const err = await querySecurityAdvisor(REF, { token: "t", fetch: fakeFetch(status, { message: "secret detail" }) as unknown as typeof fetch }).catch((e: unknown) => e);
      expect(err).toBeInstanceOf(AdvisorApiError);
      expect(String((err as Error).message)).not.toMatch(/secret detail/);
      expect(postureSourceStatus(err)).toBe(code);
    },
  );

  it("fails on a body without a lints array or one that is not JSON, never reading it as no findings", async () => {
    for (const body of [{ result: [] }, [], "not json"]) {
      const err = await querySecurityAdvisor(REF, { token: "t", fetch: fakeFetch(200, body) as unknown as typeof fetch }).catch((e: unknown) => e);
      expect(postureSourceStatus(err)).toBe("invalid_response");
    }
  });

  it("refuses a bad ref before any request", async () => {
    const f = fakeFetch(200, { lints: [] });
    await expect(querySecurityAdvisor("../../v1/x", { token: "t", fetch: f as unknown as typeof fetch })).rejects.toThrow(/project ref/);
    expect(f).not.toHaveBeenCalled();
  });

  it("keeps only the lint name, level, type and identifiers; never title, description, detail or remediation", async () => {
    const lints = await querySecurityAdvisor(REF, { token: "t", fetch: fakeFetch(200, { lints: [lint("rls_disabled_in_public")] }) as unknown as typeof fetch });
    expect(lints).toEqual([{ name: "rls_disabled_in_public", level: "ERROR", security: true, schema: "public", object: "notes", type: "table" }]);
    expect(JSON.stringify(lints)).not.toMatch(/Free text|ignore|example\.test/);
  });

  it("drops lints with a free-text name or an unknown level, and unknown object types become null", () => {
    expect(parseLints([lint("Drop table x;"), lint("ok_lint", { level: "FATAL" }), lint("new_lint", { type: "sequence" })]))
      .toEqual([{ name: "new_lint", level: "ERROR", security: true, schema: "public", object: "notes", type: null }]);
  });
});

describe("advisorFindings", () => {
  it("maps ERROR/WARN/INFO to high/medium/low and keeps security lints only", () => {
    const r = advisorFindings(parseLints([
      lint("security_definer_view", { type: "view", object: "v" }),
      lint("function_search_path_mutable", { level: "WARN", type: "function", object: "f" }),
      lint("rls_enabled_no_policy", { level: "INFO" }),
      lint("unindexed_foreign_keys", { categories: ["PERFORMANCE"] }),
    ]));
    expect(r.status).toBe("ok");
    expect(r.status === "ok" && r.findings.map((f) => [f.check, f.severity])).toEqual([
      ["security_definer_view", "high"], ["function_search_path_mutable", "medium"], ["rls_enabled_no_policy", "low"],
    ]);
  });

  it("treats the Advisor's own 'check unavailable' lint as unable to assess, never zero findings", () => {
    expect(advisorFindings(parseLints([lint("advisor_check_unavailable"), lint("rls_disabled_in_public")]))).toEqual({ status: "unavailable" });
  });

  it("knows every lint name in the reference", () => {
    expect(ADVISOR_LINTS).toHaveLength(45);
  });
});

const finding = (o: Partial<PostureFinding>): PostureFinding => ({
  source: "catalog", check: "rls_disabled", severity: "critical", schema: "public", object: "notes", objectType: "table",
  evidence: { exposure: "anon", policyCount: 0 }, ...o,
});

describe("dedupe, counts and exposed tables", () => {
  it("drops an Advisor finding a catalog finding already reports on the same object", () => {
    const list = dedupePosture([
      finding({}),
      finding({ source: "advisor", check: "rls_disabled_in_public", severity: "high" }),
      finding({ source: "advisor", check: "rls_disabled_in_public", severity: "high", object: "other" }),
      finding({ source: "advisor", check: "auth_leaked_password_protection", severity: "medium", schema: null, object: null, objectType: "auth" }),
    ]);
    expect(list.map((f) => `${f.source}:${f.check}:${f.object}`)).toEqual([
      "catalog:rls_disabled:notes", "advisor:rls_disabled_in_public:other", "advisor:auth_leaked_password_protection:null",
    ]);
    expect(countBySeverity(list)).toEqual({ critical: 1, high: 1, medium: 1, low: 0 });
  });

  it("keeps an Advisor finding when no catalog finding covers it", () => {
    expect(dedupePosture([finding({ source: "advisor", check: "rls_disabled_in_public" })])).toHaveLength(1);
  });

  it("lists public tables at high or above only", () => {
    const m = exposedTables([
      finding({}), finding({ object: "low_one", severity: "low" }), finding({ object: "v", objectType: "view" }),
      finding({ schema: "private", object: "x" }), finding({ source: "advisor", check: "policy_exists_rls_disabled", object: "adv", severity: "high" }),
    ]);
    expect([...m.entries()]).toEqual([["notes", "rls_disabled"], ["adv", "policy_exists_rls_disabled"]]);
  });
});

describe("raiseForPosture", () => {
  const scope = projectScope("11111111-1111-4111-8111-111111111111", "22222222-2222-4222-8222-222222222222");
  const det = (o: Partial<Finding>): Finding => ({
    detector: "cross_tenant", severity: "high", actor: "user:a", signals: ["any_owner"], firstSeen: "x", lastSeen: "x",
    hits: 3, evidence: { table: "notes", column: "user_id" }, ...o,
  });
  const exposed = new Map([["notes", "rls_disabled"]]);

  it("raises a cross-tenant detection on an exposed table one step and says why", () => {
    const [f] = raiseForPosture([det({})], exposed);
    expect(f).toMatchObject({ severity: "critical", signals: ["any_owner", POSTURE_SIGNAL], evidence: { postureCheck: "rls_disabled" } });
    expect(raiseForPosture([det({ severity: "low" })], exposed)[0]!.severity).toBe("medium");
    expect(raiseForPosture([det({ severity: "critical" })], exposed)[0]!.severity).toBe("critical");
  });

  it("leaves other tables, service-role findings and an empty map alone", () => {
    const other = det({ evidence: { table: "profiles" } });
    const service = det({ detector: "service_role_misuse" });
    expect(raiseForPosture([other, service], exposed)).toEqual([other, service]);
    expect(raiseForPosture([det({})], new Map())[0]!.severity).toBe("high");
  });

  it("passes the signal to the explainer's features", () => {
    const [f] = raiseForPosture([det({})], exposed);
    const features = buildFeatures({
      id: null, scope, actor: "user:a", status: "open", severity: f!.severity, detectors: ["cross_tenant"], signals: f!.signals,
      findingCount: 1, hits: 3, openedAt: new Date(), lastSeenAt: new Date(),
    }, [f!]);
    expect(features.signals).toContain(POSTURE_SIGNAL);
  });
});

describe("fix prompts", () => {
  it("quotes identifiers and doubles quotes inside them", () => {
    expect(quoteIdent('we"ird')).toBe('"we""ird"');
  });

  it("enables RLS with an owner policy example for a table without policies", () => {
    const p = fixPrompt(finding({}));
    expect(p.title).toBe("Row level security is off");
    expect(p.sql).toContain('ALTER TABLE "public"."notes" ENABLE ROW LEVEL SECURITY;');
    expect(p.sql).toContain('CREATE POLICY "Owners read their rows" ON "public"."notes"');
    expect(p.explanation).toMatch(/anon key/);
  });

  it("warns that existing policies take effect when RLS goes on", () => {
    const p = fixPrompt(finding({ evidence: { exposure: "authenticated", policyCount: 2 } }));
    expect(p.sql).toMatch(/2 existing policies take effect at once/);
    expect(p.sql).not.toContain("CREATE POLICY");
  });

  it("alters an open policy with the clause its command takes", () => {
    const base = { check: "permissive_policy", severity: "high" as const, evidence: { policy: "p", roles: ["authenticated"], exposure: "authenticated" } };
    const read = fixPrompt(finding({ ...base, evidence: { ...base.evidence, command: "SELECT", openCommands: ["SELECT"] } }));
    expect(read.sql).toContain('ALTER POLICY "p" ON "public"."notes"\n  USING ((select auth.uid()) = user_id);');
    expect(read.sql).toMatch(/meant to be public/);
    const insert = fixPrompt(finding({ ...base, evidence: { ...base.evidence, command: "INSERT", openCommands: ["INSERT"] } }));
    expect(insert.sql).toContain('ALTER POLICY "p" ON "public"."notes"\n  WITH CHECK ((select auth.uid()) = user_id);');
    expect(insert.sql).not.toContain("USING (");
    const all = fixPrompt(finding({ ...base, evidence: { ...base.evidence, command: "ALL", openCommands: ["SELECT", "UPDATE"] } }));
    expect(all.sql).toContain("  USING ((select auth.uid()) = user_id)\n  WITH CHECK ((select auth.uid()) = user_id);");
    expect(checkTitle(finding({ ...base, evidence: { openCommands: ["UPDATE"] } }))).toBe("A policy lets any row be changed");
  });

  it("sets security_invoker on a view", () => {
    expect(fixPrompt(finding({ check: "view_not_invoker", object: "v", objectType: "view", evidence: { exposure: "anon" } })).sql)
      .toContain('ALTER VIEW "public"."v" SET (security_invoker = true);');
  });

  it("gives Advisor lints SQL where the fix is SQL, and dashboard steps otherwise", () => {
    expect(fixPrompt(finding({ source: "advisor", check: "function_search_path_mutable", object: "f", objectType: "function", evidence: { level: "WARN" } })).sql)
      .toContain(`ALTER FUNCTION "public"."f" SET search_path = '';`);
    const auth = fixPrompt(finding({ source: "advisor", check: "auth_leaked_password_protection", schema: null, object: null, objectType: "auth", evidence: {} }));
    expect(auth).toMatchObject({ title: "Leaked password protection is off", sql: null });
    expect(fixPrompt(finding({ source: "advisor", check: "brand_new_lint", evidence: {} })).title).toBe("Brand new lint");
  });

  it("never puts a newline from a name into the SQL, because such names never get stored", () => {
    // safeName refuses them at parse time; this proves the parse path end to end.
    const rows = [table("x\n-- DROP TABLE users;", { rls: false })];
    expect(run(rows)).toEqual([]);
  });
});

describe("postureSourceStatus", () => {
  it("maps errors to stored codes", () => {
    expect(postureSourceStatus(new SqlQueryError("x", 403))).toBe("unauthorized");
    expect(postureSourceStatus(new SqlQueryError("x", 201))).toBe("invalid_response");
    expect(postureSourceStatus(new CatalogError("x"))).toBe("invalid_response");
    expect(postureSourceStatus(new TypeError("fetch failed"))).toBe("network_error");
  });
});
