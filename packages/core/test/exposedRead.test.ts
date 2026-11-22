import { describe, expect, it } from "vitest";
import { actorAlias, detectorLabel, signalLabel } from "../src/alerts/email.js";
import { BULK_READ_ROWS, detectExposedReads } from "../src/detectors/exposedRead.js";
import { buildFeatures } from "../src/explainer/features.js";
import { templateExplanation } from "../src/explainer/template.js";
import { validateExplanation } from "../src/explainer/validate.js";
import { applyFindings } from "../src/incidents/engine.js";
import { anonReadTables, edgeRollupSql, MAX_ANON_READ_TABLES } from "../src/logs/sql.js";
import { catalogFindings, parseCatalogRows } from "../src/posture/catalog.js";
import { anonReadableTables, type AnonReadable } from "../src/posture/findings.js";
import type { PostureFinding } from "../src/posture/types.js";
import { scan } from "../src/scan.js";
import { ServiceRoleNetworks } from "../src/detectors/serviceRole.js";
import { projectScope } from "../src/tenancy/scope.js";
import { CHROME_UA, event } from "./helpers.js";

// Issue #132: anon-key reads of tables the posture scan shows readable by anon.

const SCOPE = projectScope("aaaaaaaa-0000-4000-8000-000000000001", "11111111-0000-4000-8000-0000000000aa");

const anonRead = (o: Parameters<typeof event>[0] = {}) => event({
  path: "/rest/v1/customers", search: "?select=*", jwtSubject: null, jwtRole: "anon", apiKeyRole: "anon",
  userAgent: "curl/8.7.1", clientInfo: null, asn: 14061, asOrganization: "DigitalOcean, LLC",
  contentRange: "0-99/*", hits: 3, ...o,
});

const READABLE = new Map<string, AnonReadable>([
  ["customers", { check: "rls_disabled", severity: "critical" }],
  ["posts", { check: "permissive_policy", severity: "medium" }],
]);

const pf = (o: Partial<PostureFinding>): PostureFinding => ({
  source: "catalog", check: "rls_disabled", severity: "critical", schema: "public", object: "customers", objectType: "table",
  evidence: { exposure: "anon", anonPrivileges: ["SELECT"], authenticatedPrivileges: [], policyCount: 0 }, ...o,
});

describe("anonReadableTables (posture → watched tables)", () => {
  it("keeps RLS-off tables with an anon SELECT grant and permissive policies anon can read", () => {
    const m = anonReadableTables([
      pf({}),
      pf({ object: "writes_only", evidence: { exposure: "anon", anonPrivileges: ["INSERT"] } }),
      pf({ object: "auth_only", severity: "high", evidence: { exposure: "authenticated", anonPrivileges: [] } }),
      pf({ check: "permissive_policy", object: "posts", severity: "medium",
        evidence: { openCommands: ["SELECT"], roles: ["public"], exposure: "anon", readExposure: "anon" } }),
      // Opens writes to authenticated (so the stored exposure says authenticated) and reads to anon.
      pf({ check: "permissive_policy", object: "guestbook", severity: "high",
        evidence: { openCommands: ["SELECT", "INSERT"], roles: ["public"], exposure: "authenticated", readExposure: "anon" } }),
      pf({ check: "permissive_policy", object: "members_only", severity: "low",
        evidence: { openCommands: ["SELECT"], roles: ["authenticated"], exposure: "authenticated", readExposure: "authenticated" } }),
      pf({ check: "permissive_policy", object: "open_insert", severity: "critical",
        evidence: { openCommands: ["INSERT"], roles: ["anon"], exposure: "anon", readExposure: "none" } }),
      // Stored before readExposure existed: inferred from roles and exposure.
      pf({ check: "permissive_policy", object: "legacy", severity: "medium", evidence: { openCommands: ["SELECT"], roles: ["anon"], exposure: "anon" } }),
      pf({ source: "advisor", check: "rls_disabled_in_public", object: "advisor_only", severity: "high", evidence: { level: "ERROR" } }),
      pf({ schema: "private", object: "elsewhere" }),
      pf({ object: "a_view", objectType: "view", check: "view_not_invoker" }),
    ]);
    expect([...m.entries()].sort()).toEqual([
      ["advisor_only", { check: "rls_disabled_in_public", severity: "high" }],
      ["customers", { check: "rls_disabled", severity: "critical" }],
      ["guestbook", { check: "permissive_policy", severity: "high" }],
      ["legacy", { check: "permissive_policy", severity: "medium" }],
      ["posts", { check: "permissive_policy", severity: "medium" }],
    ]);
  });

  it("drops the Advisor's RLS lint when the catalog knows anon has no grant", () => {
    const m = anonReadableTables([
      pf({ object: "t", severity: "low", evidence: { exposure: "none", anonPrivileges: [] } }),
      pf({ source: "advisor", check: "rls_disabled_in_public", object: "t", severity: "high", evidence: {} }),
    ]);
    expect(m.size).toBe(0);
  });

  it("reads the catalog's own readExposure for a policy", () => {
    const catalog = parseCatalogRows([
      { kind: "table", schema_name: "public", object_name: "posts", rls_enabled: true, policy_count: 1, grants: "anon:SELECT,authenticated:SELECT" },
      { kind: "policy", schema_name: "public", object_name: "posts", policy_name: "read all", permissive: "PERMISSIVE", roles: "{public}", cmd: "SELECT", qual: "true" },
    ]);
    const [f] = catalogFindings(catalog);
    expect(f!.evidence).toMatchObject({ readExposure: "anon" });
    expect(anonReadableTables([f!]).has("posts")).toBe(true);
  });
});

describe("rollup SQL anon-read branch", () => {
  it("adds no branch when no table is exposed", () => {
    expect(edgeRollupSql({ env: {} })).toBe(edgeRollupSql({ env: {}, anonReadTables: [] }));
    expect(edgeRollupSql({ env: {} })).not.toContain("IN ('GET', 'HEAD')");
    expect(edgeRollupSql({ env: {} })).not.toContain("'/rest/v1/");
  });

  it("matches anon GET/HEAD on exactly the exposed table paths", () => {
    const sql = edgeRollupSql({ env: {}, anonReadTables: ["posts", "customers"] });
    expect(sql).toContain("IN ('GET', 'HEAD')");
    expect(sql).toContain("log_attributes['request.sb.jwt.authorization.payload.role'] = 'anon'");
    expect(sql).toContain("log_attributes['request.sb.jwt.apikey.payload.role'] = 'anon'");
    expect(sql).toContain("IN ('/rest/v1/customers', '/rest/v1/posts')");
  });

  it("passes only plain identifiers, sorted and capped", () => {
    expect(anonReadTables(["b", "a", "a", "it's", "Upper", "x\u0000y", "with space", "rpc_ok"])).toEqual(["a", "b", "rpc_ok"]);
    const many = Array.from({ length: MAX_ANON_READ_TABLES + 50 }, (_, i) => `t${String(i).padStart(4, "0")}`);
    expect(anonReadTables(many)).toHaveLength(MAX_ANON_READ_TABLES);
    const sql = edgeRollupSql({ env: {}, anonReadTables: ["evil') OR 1=1 --", "ok"] });
    expect(sql).not.toContain("evil");
    expect(sql).toContain("'/rest/v1/ok'");
  });
});

describe("detectExposedReads", () => {
  it("rates rows from a critical-posture table high, with structured evidence only", () => {
    const [f, ...rest] = detectExposedReads([anonRead()], READABLE);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      detector: "exposed_read", severity: "high", actor: "anon:asn:14061", hits: 3,
      signals: ["exposed_table_read", "rows_returned"],
      evidence: {
        table: "customers", postureCheck: "rls_disabled", postureSeverity: "critical", rowsReturned: 300,
        outcome: "rows_returned", asn: 14061, callerClass: "manual_tool", networkType: "hosting",
      },
    });
    // No raw user agent, query or path in the evidence.
    expect(JSON.stringify(f!.evidence)).not.toMatch(/curl|select|rest\/v1|DigitalOcean/);
  });

  it("sums rows and hits per table, network and caller class", () => {
    const findings = detectExposedReads([
      anonRead({ search: "?offset=0", hits: 2, firstSeen: "2026-10-27T12:01:00Z", lastSeen: "2026-10-27T12:02:00Z" }),
      anonRead({ search: "?offset=100", hits: 1, contentRange: "100-149/*", firstSeen: "2026-10-27T12:00:00Z", lastSeen: "2026-10-27T12:03:00Z" }),
      anonRead({ asn: 7922, asOrganization: "Comcast", userAgent: CHROME_UA, clientInfo: "supabase-js-web/2.80.0", hits: 1 }),
    ], READABLE);
    expect(findings.map((f) => [f.actor, f.hits, f.evidence.rowsReturned, f.evidence.callerClass, f.firstSeen, f.lastSeen])).toEqual([
      ["anon:asn:14061", 3, 250, "manual_tool", "2026-10-27T12:00:00Z", "2026-10-27T12:03:00Z"],
      ["anon:asn:7922", 1, 100, "browser", "2026-10-27T12:00:00Z", "2026-10-27T12:00:00Z"],
    ]);
  });

  it("raises a bulk read of a critical table to critical, and of a policy-open table to medium", () => {
    const bulk = { contentRange: `0-${BULK_READ_ROWS - 1}/*`, hits: 1 };
    expect(detectExposedReads([anonRead(bulk)], READABLE)[0]).toMatchObject({
      severity: "critical", signals: ["exposed_table_read", "rows_returned", "bulk_read"],
    });
    expect(detectExposedReads([anonRead({ ...bulk, path: "/rest/v1/posts" })], READABLE)[0]!.severity).toBe("medium");
    expect(detectExposedReads([anonRead({ path: "/rest/v1/posts" })], READABLE)[0]!.severity).toBe("low");
  });

  it("rates an empty or unknown answer low", () => {
    expect(detectExposedReads([anonRead({ contentRange: "*/0" })], READABLE)[0]).toMatchObject({
      severity: "low", signals: ["exposed_table_read"], evidence: { rowsReturned: 0, outcome: "empty" },
    });
    expect(detectExposedReads([anonRead({ contentRange: null })], READABLE)[0]).toMatchObject({
      severity: "low", evidence: { rowsReturned: null, outcome: "unknown" },
    });
  });

  it("ignores rejected requests, writes, other roles, other tables and an empty posture map", () => {
    expect(detectExposedReads([anonRead({ status: 401 })], READABLE)).toEqual([]);
    expect(detectExposedReads([anonRead({ method: "PATCH" })], READABLE)).toEqual([]);
    expect(detectExposedReads([anonRead({ jwtRole: "authenticated", jwtSubject: "u" })], READABLE)).toEqual([]);
    expect(detectExposedReads([anonRead({ jwtRole: "service_role", apiKeyRole: "service_role" })], READABLE)).toEqual([]);
    expect(detectExposedReads([anonRead({ path: "/rest/v1/notes" })], READABLE)).toEqual([]);
    expect(detectExposedReads([anonRead({ path: "/rest/v1/rpc/customers" })], READABLE)).toEqual([]);
    expect(detectExposedReads([anonRead()], new Map())).toEqual([]);
  });

  it("reads the API key's role when no user JWT is sent", () => {
    expect(detectExposedReads([anonRead({ jwtRole: null })], READABLE)).toHaveLength(1);
  });

  it("runs inside scan() only when posture is passed", () => {
    const ctx = { scope: SCOPE, networks: new ServiceRoleNetworks(), ownership: {} };
    expect(scan([anonRead()], ctx)).toEqual([]);
    expect(scan([anonRead()], { ...ctx, anonReadable: READABLE }).map((f) => f.detector)).toEqual(["exposed_read"]);
  });
});

describe("exposed reads in incidents, explanations and alerts", () => {
  const findings = detectExposedReads([anonRead()], READABLE);
  const { updates } = applyFindings(SCOPE, [], findings, new Date("2026-10-27T12:05:00Z"));
  const u = updates[0]!;

  it("opens one paging incident per anon network", () => {
    expect(updates).toHaveLength(1);
    expect(u).toMatchObject({ notify: true, incident: { actor: "anon:asn:14061", severity: "high", detectors: ["exposed_read"] } });
  });

  it("builds whitelisted features, and the template passes the validator", () => {
    const features = buildFeatures(u.incident, u.findings);
    expect(features).toMatchObject({
      actorKind: "anon_key",
      signals: ["exposed_table_read", "rows_returned"],
      exposedRead: {
        tables: ["customers"], postureChecks: ["rls_disabled"], postureSeverities: ["critical"], rowsReturned: 300,
        callerClasses: ["manual_tool"], networkTypes: ["hosting"], asns: [14061],
      },
    });
    const text = templateExplanation(features);
    expect(text.likelyImpact).toContain("300 row(s)");
    expect(text.nextSteps[0]).toContain("`customers`");
    expect(validateExplanation(text, features)).toEqual([]);
  });

  it("drops evidence values outside the whitelist", () => {
    const bad = { ...findings[0]!, evidence: { ...findings[0]!.evidence, table: "x; drop", postureCheck: "Free Text", callerClass: "evil" } };
    const f = buildFeatures(u.incident, [bad]);
    expect(f.exposedRead).toMatchObject({ tables: [], postureChecks: [], callerClasses: [] });
  });

  it("labels the detector, its signals and the anon actor", () => {
    expect(detectorLabel("exposed_read")).toBe("Anon reads of an exposed table");
    expect(signalLabel("bulk_read")).not.toBe("bulk read");
    expect(actorAlias("anon:asn:14061")).toBe("Signed-out callers (anon key) on AS14061");
    expect(actorAlias("anon:asn:unknown")).toBe("Signed-out callers (anon key)");
  });
});
