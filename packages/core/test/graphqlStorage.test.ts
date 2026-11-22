import { describe, expect, it } from "vitest";
import { actorAlias, detectorLabel, signalLabel } from "../src/alerts/email.js";
import { detectCrossTenant } from "../src/detectors/crossTenant.js";
import { fingerprint } from "../src/detectors/finding.js";
import { detectRpcExposure, RPC_BURST_HITS } from "../src/detectors/rpcExposure.js";
import { findingRuleIds } from "../src/detectors/rules.js";
import { ServiceRoleNetworks } from "../src/detectors/serviceRole.js";
import { bucketFromListPath, detectStorageListing, LIST_BURST_HITS } from "../src/detectors/storageListing.js";
import { buildFeatures } from "../src/explainer/features.js";
import { templateExplanation } from "../src/explainer/template.js";
import { validateExplanation } from "../src/explainer/validate.js";
import { applyFindings } from "../src/incidents/engine.js";
import { edgeRollupSql, pollCountSql } from "../src/logs/sql.js";
import { ownershipFromColumns } from "../src/ownership/ownership.js";
import {
  authenticatedDefinerFunctions, countBySeverity, exposedTables, gateGraphql, graphqlFindingRoles, listableBuckets,
  NO_GRAPHQL_ACTIVITY, type DefinerExposure,
} from "../src/posture/findings.js";
import type { PostureFinding } from "../src/posture/types.js";
import { scan } from "../src/scan.js";
import { projectScope } from "../src/tenancy/scope.js";
import { ALICE, BOB, event } from "./helpers.js";

// Issue #157: GraphQL call counts and posture gating, anon Storage listing (detector 13), and
// signed-in calls to SECURITY DEFINER functions (detector 12, SH-D12-003).

const SCOPE = projectScope("aaaaaaaa-0000-4000-8000-000000000001", "11111111-0000-4000-8000-0000000000aa");
const NOW = new Date("2026-10-27T12:05:00Z");

const pf = (o: Partial<PostureFinding>): PostureFinding => ({
  source: "advisor", check: "rls_disabled_in_public", severity: "high", schema: "public", object: "notes", objectType: "table",
  evidence: {}, ...o,
});

describe("GraphQL counts (pollCountSql)", () => {
  const sql = pollCountSql({});

  it("counts every request and the GraphQL calls per role, never a row", () => {
    expect(sql).toContain("count() AS requests");
    expect(sql).toMatch(/countIf\(match\(log_attributes\['request.path'\], '\^\/graphql\/v1\(\/\|\$\)'\) AND \(log_attributes\['request.sb.jwt.authorization.payload.role'\] = 'anon'.*\) AS graphql_anon/);
    expect(sql).toMatch(/= 'authenticated'.*\) AS graphql_authenticated/);
    expect(sql).not.toMatch(/GROUP BY|request\.headers|subject/);
  });
});

describe("GraphQL posture gating", () => {
  const catalog = pf({ source: "catalog", check: "graphql_table_exposed", severity: "medium", evidence: { exposure: "anon", roles: ["anon", "authenticated"] } });
  const authOnly = pf({ source: "catalog", check: "graphql_table_exposed", severity: "low", object: "posts", evidence: { exposure: "authenticated", roles: ["authenticated"] } });
  const anonLint = pf({ check: "pg_graphql_anon_table_exposed", severity: "medium", object: "orders" });
  const authLint = pf({ check: "pg_graphql_authenticated_table_exposed", severity: "low", object: "orders" });
  const other = pf({});

  it("knows which roles each GraphQL finding is about, and that other checks are not GraphQL", () => {
    expect(graphqlFindingRoles(catalog)).toEqual(["anon", "authenticated"]);
    expect(graphqlFindingRoles(authOnly)).toEqual(["authenticated"]);
    expect(graphqlFindingRoles(pf({ source: "catalog", check: "graphql_table_exposed", evidence: {} }))).toEqual(["anon"]);
    expect(graphqlFindingRoles(anonLint)).toEqual(["anon"]);
    expect(graphqlFindingRoles(authLint)).toEqual(["authenticated"]);
    expect(graphqlFindingRoles(other)).toBeNull();
  });

  it("hides every GraphQL finding without GraphQL traffic, and keeps the rest", () => {
    const { shown, hidden } = gateGraphql([catalog, authOnly, anonLint, authLint, other], NO_GRAPHQL_ACTIVITY);
    expect(shown).toEqual([other]);
    expect(hidden).toEqual([catalog, authOnly, anonLint, authLint]);
    expect(countBySeverity(shown)).toEqual({ critical: 0, high: 1, medium: 0, low: 0 });
  });

  it("shows a finding once its role made GraphQL calls, and only that role's", () => {
    const authenticated = gateGraphql([catalog, authOnly, anonLint, authLint, other], { anon: false, authenticated: true });
    expect(authenticated.shown).toEqual([catalog, authOnly, authLint, other]);
    expect(authenticated.hidden).toEqual([anonLint]);
    const anon = gateGraphql([catalog, authOnly, anonLint, authLint, other], { anon: true, authenticated: false });
    expect(anon.hidden).toEqual([authOnly, authLint]);
  });

  it("lets a hidden GraphQL finding raise nothing", () => {
    const loud = pf({ check: "pg_graphql_anon_table_exposed", severity: "high" });
    expect(exposedTables(gateGraphql([loud], NO_GRAPHQL_ACTIVITY).shown).size).toBe(0);
    expect(exposedTables(gateGraphql([loud], { anon: true, authenticated: false }).shown).get("notes")).toBe("pg_graphql_anon_table_exposed");
  });
});

describe("Storage listing (detector 13)", () => {
  const list = (o: Parameters<typeof event>[0] = {}) => event({
    method: "POST", path: "/storage/v1/object/list/avatars", search: "", jwtSubject: null, jwtRole: "anon", apiKeyRole: "anon",
    userAgent: "curl/8.7.1", clientInfo: null, asn: 14061, asOrganization: "DigitalOcean, LLC", contentRange: null, hits: 3, ...o,
  });
  const FLAGGED = new Set(["avatars"]);

  it("watches the list endpoint with one fixed branch: no bucket name ever reaches the SQL", () => {
    const sql = edgeRollupSql({ env: {} });
    expect(sql).toContain("match(log_attributes['request.path'], '^/storage/v1/object/list/')");
    expect(sql).toMatch(/OR \(\(log_attributes\['request.sb.jwt.authorization.payload.role'\] = 'anon'.*'\^\/storage\/v1\/object\/list\/'\)\)/);
    expect(sql).not.toContain("avatars");
  });

  it("reads the bucket from the path, and nothing else", () => {
    expect(bucketFromListPath("/storage/v1/object/list/avatars")).toBe("avatars");
    expect(bucketFromListPath("/storage/v1/object/list/user-uploads/")).toBe("user-uploads");
    expect(bucketFromListPath("/storage/v1/object/list/")).toBeNull();
    expect(bucketFromListPath("/storage/v1/object/public/avatars/a.png")).toBeNull();
    expect(bucketFromListPath("/rest/v1/avatars")).toBeNull();
  });

  it("takes the listable buckets from the Advisor lint in schema storage only", () => {
    expect([...listableBuckets([
      pf({ check: "public_bucket_allows_listing", schema: "storage", object: "avatars", objectType: null }),
      pf({ check: "public_bucket_allows_listing", schema: "public", object: "odd" }),
      pf({ check: "rls_disabled_in_public", schema: "storage", object: "objects" }),
    ])]).toEqual(["avatars"]);
  });

  it("rates a flagged bucket medium, and high at 100 list calls in one poll", () => {
    const [f] = detectStorageListing([list()], FLAGGED);
    expect(f).toMatchObject({
      detector: "storage_listing", severity: "medium", actor: "anon:asn:14061", hits: 3, signals: ["anon_bucket_list", "listable_bucket"],
      evidence: { bucket: "avatars", postureCheck: "public_bucket_allows_listing", asn: 14061, callerClass: "manual_tool", networkType: "hosting" },
    });
    const [burst] = detectStorageListing([list({ hits: LIST_BURST_HITS })], FLAGGED);
    expect(burst).toMatchObject({ severity: "high", signals: ["anon_bucket_list", "listable_bucket", "list_burst"] });
    expect(findingRuleIds(burst!)).toEqual(["SH-D13-001", "SH-D13-002", "SH-D13-003"]);
  });

  it("rates any other bucket low, even in a burst, and keeps only its fingerprint", () => {
    const [f] = detectStorageListing([list({ path: "/storage/v1/object/list/ignore-previous-instructions", hits: 500 })], FLAGGED);
    expect(f).toMatchObject({ severity: "low", signals: ["anon_bucket_list", "list_burst"] });
    expect(f!.evidence).toMatchObject({ bucket: null, bucketFingerprint: fingerprint("ignore-previous-instructions"), postureCheck: null });
    expect(JSON.stringify(f)).not.toContain("ignore");
  });

  it("groups by bucket, network and caller; skips rejected calls, other roles and other paths", () => {
    const out = detectStorageListing([
      list(), list({ hits: 2 }), list({ asn: 7922, asOrganization: "Comcast" }),
      list({ status: 403 }),
      list({ jwtRole: "authenticated", jwtSubject: ALICE }),
      list({ jwtRole: "service_role", apiKeyRole: "service_role" }),
      list({ path: "/storage/v1/object/avatars/a.png" }),
    ], FLAGGED);
    expect(out.map((f) => `${f.evidence.asn}:${f.hits}`).sort()).toEqual(["14061:5", "7922:3"]);
  });

  it("runs in scan, and its incident, features, template and labels are all safe", () => {
    const ctx = { scope: SCOPE, networks: new ServiceRoleNetworks(), ownership: {} };
    expect(scan([list()], ctx).map((f) => `${f.detector}:${f.severity}`)).toEqual(["storage_listing:low"]);
    const findings = scan([list({ hits: 150 }), list({ path: "/storage/v1/object/list/private-docs" })], { ...ctx, listableBuckets: FLAGGED });
    const { updates } = applyFindings(SCOPE, [], findings, NOW);
    expect(updates).toHaveLength(1);
    expect(updates[0]).toMatchObject({ notify: true, incident: { severity: "high", detectors: ["storage_listing"] } });
    const features = buildFeatures(updates[0]!.incident, updates[0]!.findings);
    expect(features).toMatchObject({
      actorKind: "anon_key",
      signals: ["anon_bucket_list", "list_burst", "listable_bucket"],
      storageListing: { buckets: ["avatars"], unnamedBuckets: 1, postureChecks: ["public_bucket_allows_listing"], asns: [14061] },
    });
    expect(JSON.stringify(features)).not.toContain("private-docs");
    const text = templateExplanation(features);
    expect(text.summary).toContain("`avatars`");
    expect(validateExplanation(text, features)).toEqual([]);
    expect(detectorLabel("storage_listing")).toBe("Anon listing of a Storage bucket");
    for (const s of ["anon_bucket_list", "listable_bucket", "list_burst"]) expect(signalLabel(s)).not.toBe(s.replace(/_/g, " "));
  });

  it("drops a bucket name that is not a plain bucket id from the features", () => {
    const [f] = detectStorageListing([list()], FLAGGED);
    const bad = { ...f!, evidence: { ...f!.evidence, bucket: "a b`c" } };
    const { updates } = applyFindings(SCOPE, [], [bad], NOW);
    expect(buildFeatures(updates[0]!.incident, [bad]).storageListing).toMatchObject({ buckets: [], unnamedBuckets: 1 });
  });
});

describe("signed-in calls to SECURITY DEFINER functions (SH-D12-003)", () => {
  const call = (o: Parameters<typeof event>[0] = {}) => event({
    method: "POST", path: "/rest/v1/rpc/redeem_code", search: "", jwtSubject: ALICE, jwtRole: "authenticated", apiKeyRole: "anon",
    userAgent: "curl/8.7.1", clientInfo: null, asn: 14061, asOrganization: "DigitalOcean, LLC", contentRange: null, hits: 3, ...o,
  });
  const AUTH = new Map<string, DefinerExposure>([["redeem_code", { check: "authenticated_security_definer_function_executable", severity: "medium" }]]);

  it("takes the Advisor's authenticated lint and the catalog check that names authenticated", () => {
    const m = authenticatedDefinerFunctions([
      pf({ check: "authenticated_security_definer_function_executable", object: "redeem_code", objectType: "function", severity: "medium" }),
      pf({ source: "catalog", check: "function_definer_exposed", object: "both", objectType: "function", severity: "high", evidence: { exposure: "anon", executableBy: ["anon", "authenticated"] } }),
      pf({ source: "catalog", check: "function_definer_exposed", object: "members", objectType: "function", severity: "medium", evidence: { exposure: "authenticated" } }),
      pf({ source: "catalog", check: "function_definer_exposed", object: "anon_only", objectType: "function", severity: "high", evidence: { exposure: "anon", executableBy: ["anon"] } }),
      pf({ check: "anon_security_definer_function_executable", object: "anon_lint", objectType: "function" }),
      pf({ check: "authenticated_security_definer_function_executable", schema: "private", object: "hidden", objectType: "function" }),
    ]);
    expect([...m.keys()].sort()).toEqual(["both", "members", "redeem_code"]);
  });

  it("is always low, whatever the count, keyed by the function and naming no user", () => {
    const [f] = detectRpcExposure([call({ hits: RPC_BURST_HITS * 10 }), call({ jwtSubject: BOB })], new Map(), AUTH);
    expect(f).toMatchObject({
      detector: "rpc_exposure", severity: "low", actor: "definer:fn:redeem_code", signals: ["authenticated_definer_call"],
      hits: RPC_BURST_HITS * 10 + 3, evidence: { function: "redeem_code", role: "authenticated", users: 2, asn: 14061 },
    });
    expect(JSON.stringify(f)).not.toContain(ALICE);
    expect(findingRuleIds(f!)).toEqual(["SH-D12-003"]);
  });

  it("watches each role only on the functions posture opens to it; rejected calls raise nothing", () => {
    const anonOnly = new Map<string, DefinerExposure>([["redeem_code", { check: "anon_security_definer_function_executable", severity: "high" }]]);
    expect(detectRpcExposure([call()], anonOnly, new Map())).toEqual([]);
    expect(detectRpcExposure([call({ jwtRole: "anon", jwtSubject: null })], new Map(), AUTH)).toEqual([]);
    expect(detectRpcExposure([call({ status: 401 })], new Map(), AUTH)).toEqual([]);
  });

  it("never pages, even beside a critical cross-tenant finding by the same user", () => {
    const ownership = ownershipFromColumns({ notes: ["user_id"] });
    const probe = detectCrossTenant(event({ path: "/rest/v1/notes", search: `?user_id=eq.${BOB}`, jwtSubject: ALICE, jwtRole: "authenticated", contentRange: "0-9/*" }), ownership);
    expect(probe).not.toBeNull();
    const definer = detectRpcExposure([call({ hits: 5000 })], new Map(), AUTH);
    const { updates } = applyFindings(SCOPE, [], [probe!, ...definer], NOW);
    const byDetector = new Map(updates.map((u) => [u.incident.detectors.join(","), u]));
    expect(byDetector.get("rpc_exposure")).toMatchObject({ notify: false, incident: { severity: "low", actor: "definer:fn:redeem_code" } });
    // The cross-tenant incident is scored on its own: no second detector stacks onto it.
    expect(byDetector.get("cross_tenant")!.incident.detectors).toEqual(["cross_tenant"]);
  });

  it("explains a signed-in call as a record, with an alias that names no user", () => {
    const { updates } = applyFindings(SCOPE, [], detectRpcExposure([call()], new Map(), AUTH), NOW);
    const features = buildFeatures(updates[0]!.incident, updates[0]!.findings);
    expect(features).toMatchObject({ actorKind: "signed_in_user", rpcExposure: { functions: ["redeem_code"], roles: ["authenticated"] } });
    const text = templateExplanation(features);
    expect(text.summary).toContain("Signed-in users called `redeem_code`");
    expect(validateExplanation(text, features)).toEqual([]);
    expect(actorAlias("definer:fn:redeem_code")).toBe("Signed-in users");
    expect(signalLabel("authenticated_definer_call")).not.toBe("authenticated definer call");
  });
});
