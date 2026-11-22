import { describe, expect, it } from "vitest";
import { actorAlias, detectorLabel, signalLabel } from "../src/alerts/email.js";
import { detectRpcExposure, isRpcBurstHits, RPC_BURST_HITS, RPC_BURST_MAX, RPC_BURST_MIN } from "../src/detectors/rpcExposure.js";
import { ServiceRoleNetworks } from "../src/detectors/serviceRole.js";
import { buildFeatures } from "../src/explainer/features.js";
import { templateExplanation } from "../src/explainer/template.js";
import { validateExplanation } from "../src/explainer/validate.js";
import { applyFindings } from "../src/incidents/engine.js";
import { anonRpcFunctions, edgeRollupSql, MAX_ANON_RPC_FUNCTIONS } from "../src/logs/sql.js";
import { rpcFunctionFromPath, tableFromPath } from "../src/postgrest/query.js";
import { anonDefinerFunctions, type DefinerExposure } from "../src/posture/findings.js";
import type { PostureFinding } from "../src/posture/types.js";
import { scan } from "../src/scan.js";
import { projectScope } from "../src/tenancy/scope.js";
import { event } from "./helpers.js";

// Issue #131 (RPC part): anon calls to SECURITY DEFINER functions posture shows anon-executable.

const SCOPE = projectScope("aaaaaaaa-0000-4000-8000-000000000001", "11111111-0000-4000-8000-0000000000aa");

const anonCall = (o: Parameters<typeof event>[0] = {}) => event({
  method: "POST", path: "/rest/v1/rpc/grant_credits", search: "", jwtSubject: null, jwtRole: "anon", apiKeyRole: "anon",
  userAgent: "curl/8.7.1", clientInfo: null, asn: 14061, asOrganization: "DigitalOcean, LLC", contentRange: null, hits: 3, ...o,
});

const DEFINERS = new Map<string, DefinerExposure>([
  ["grant_credits", { check: "anon_security_definer_function_executable", severity: "medium" }],
]);

const pf = (o: Partial<PostureFinding>): PostureFinding => ({
  source: "advisor", check: "anon_security_definer_function_executable", severity: "medium", schema: "public",
  object: "grant_credits", objectType: "function", evidence: { level: "WARN" }, ...o,
});

describe("rpcFunctionFromPath", () => {
  it("parses /rest/v1/rpc/<fn> into the function name; tables stay tables", () => {
    expect(rpcFunctionFromPath("/rest/v1/rpc/grant_credits")).toBe("grant_credits");
    expect(rpcFunctionFromPath("/rest/v1/rpc/grant_credits/")).toBe("grant_credits");
    expect(rpcFunctionFromPath("/rest/v1/rpc/My%20Fn")).toBe("My Fn");
    expect(rpcFunctionFromPath("/rest/v1/rpc")).toBeNull();
    expect(rpcFunctionFromPath("/rest/v1/rpc/a/b")).toBeNull();
    expect(rpcFunctionFromPath("/rest/v1/notes")).toBeNull();
    expect(tableFromPath("/rest/v1/rpc/grant_credits")).toBeNull();
  });
});

describe("anonDefinerFunctions (posture → watched functions)", () => {
  it("takes the Advisor lint and the catalog check, worst first, and skips other roles and schemas", () => {
    const m = anonDefinerFunctions([
      pf({}),
      pf({ source: "catalog", check: "function_definer_exposed", severity: "high", evidence: { exposure: "anon" } }),
      pf({ source: "catalog", check: "function_definer_exposed", object: "members_only", severity: "medium", evidence: { exposure: "authenticated" } }),
      pf({ source: "catalog", check: "function_definer_exposed", object: "no_exposure_field", evidence: {} }),
      pf({ check: "authenticated_security_definer_function_executable", object: "auth_fn" }),
      pf({ check: "function_search_path_mutable", object: "other_lint" }),
      pf({ schema: "private", object: "hidden" }),
    ]);
    expect([...m.entries()].sort()).toEqual([
      ["grant_credits", { check: "function_definer_exposed", severity: "high" }],
      ["no_exposure_field", { check: "function_definer_exposed", severity: "medium" }],
    ]);
  });

  it("is empty when posture has neither check", () => {
    expect(anonDefinerFunctions([pf({ check: "rls_disabled_in_public", objectType: "table" })]).size).toBe(0);
  });
});

describe("rollup SQL anon-RPC branch", () => {
  it("adds no branch when no function is exposed", () => {
    expect(edgeRollupSql({ env: {} })).toBe(edgeRollupSql({ env: {}, anonRpcFunctions: [] }));
    expect(edgeRollupSql({ env: {} })).not.toContain("/rpc/");
  });

  it("matches anon calls to exactly the exposed functions, any method", () => {
    const sql = edgeRollupSql({ env: {}, anonRpcFunctions: ["grant_credits", "add_points"] });
    expect(sql).toContain("log_attributes['request.sb.jwt.authorization.payload.role'] = 'anon'");
    expect(sql).toContain("log_attributes['request.sb.jwt.apikey.payload.role'] = 'anon'");
    expect(sql).toContain("IN ('/rest/v1/rpc/add_points', '/rest/v1/rpc/grant_credits')");
  });

  it("passes only plain identifiers, sorted and capped", () => {
    expect(anonRpcFunctions(["b", "a", "a", "it's", "Upper", "with space"])).toEqual(["a", "b"]);
    const many = Array.from({ length: MAX_ANON_RPC_FUNCTIONS + 5 }, (_, i) => `f${String(i).padStart(4, "0")}`);
    expect(anonRpcFunctions(many)).toHaveLength(MAX_ANON_RPC_FUNCTIONS);
    const sql = edgeRollupSql({ env: {}, anonRpcFunctions: ["x') OR 1=1 --", "ok"] });
    expect(sql).not.toContain("1=1");
    expect(sql).toContain("'/rest/v1/rpc/ok'");
  });
});

describe("detectRpcExposure", () => {
  it("flags anon calls with structured evidence only", () => {
    const [f, ...rest] = detectRpcExposure([anonCall()], DEFINERS);
    expect(rest).toEqual([]);
    expect(f).toMatchObject({
      detector: "rpc_exposure", severity: "medium", actor: "anon:asn:14061", hits: 3, signals: ["definer_rpc_call"],
      evidence: {
        function: "grant_credits", postureCheck: "anon_security_definer_function_executable", postureSeverity: "medium",
        method: "POST", rowsReturned: null, asn: 14061, callerClass: "manual_tool", networkType: "hosting",
      },
    });
    expect(JSON.stringify(f!.evidence)).not.toMatch(/curl|rest\/v1|DigitalOcean/);
  });

  it("sums calls per function, network and caller class, and rates a burst high", () => {
    const [f] = detectRpcExposure([
      anonCall({ hits: RPC_BURST_HITS - 1 }),
      anonCall({ method: "GET", search: "?amount=5", hits: 1, contentRange: "0-0/*" }),
    ], DEFINERS);
    expect(f).toMatchObject({
      severity: "high", hits: RPC_BURST_HITS, signals: ["definer_rpc_call", "rpc_burst"],
      evidence: { method: "mixed", rowsReturned: 1 },
    });
  });

  it("ignores rejected calls, other roles, other functions, tables and an empty posture map", () => {
    expect(detectRpcExposure([anonCall({ status: 401 })], DEFINERS)).toEqual([]);
    expect(detectRpcExposure([anonCall({ jwtRole: "authenticated", jwtSubject: "u" })], DEFINERS)).toEqual([]);
    expect(detectRpcExposure([anonCall({ path: "/rest/v1/rpc/other" })], DEFINERS)).toEqual([]);
    expect(detectRpcExposure([anonCall({ path: "/rest/v1/grant_credits" })], DEFINERS)).toEqual([]);
    expect(detectRpcExposure([anonCall()], new Map())).toEqual([]);
  });

  it("reads the API key's role when no user JWT is sent", () => {
    expect(detectRpcExposure([anonCall({ jwtRole: null })], DEFINERS)).toHaveLength(1);
  });

  it("runs inside scan() only when posture is passed", () => {
    const ctx = { scope: SCOPE, networks: new ServiceRoleNetworks(), ownership: {} };
    expect(scan([anonCall()], ctx)).toEqual([]);
    expect(scan([anonCall()], { ...ctx, anonDefiners: DEFINERS }).map((f) => f.detector)).toEqual(["rpc_exposure"]);
  });
});

describe("the project's RPC burst threshold (issue #160, decision 045)", () => {
  const burst = (hits: number, threshold?: number) => detectRpcExposure([anonCall({ hits })], DEFINERS, threshold)[0]!;

  it("defaults to RPC_BURST_HITS and records the threshold in the evidence", () => {
    expect(RPC_BURST_HITS).toBe(100);
    expect(burst(99)).toMatchObject({ severity: "medium", signals: ["definer_rpc_call"], evidence: { burstThreshold: 100 } });
    expect(burst(100)).toMatchObject({ severity: "high", signals: ["definer_rpc_call", "rpc_burst"], evidence: { burstThreshold: 100 } });
  });

  it("pages at the project's own threshold, lower or higher", () => {
    expect(burst(10, 10)).toMatchObject({ severity: "high", signals: ["definer_rpc_call", "rpc_burst"], evidence: { burstThreshold: 10 } });
    expect(burst(9, 10)).toMatchObject({ severity: "medium", signals: ["definer_rpc_call"] });
    expect(burst(250, 300)).toMatchObject({ severity: "medium", signals: ["definer_rpc_call"], evidence: { burstThreshold: 300 } });
    expect(burst(10_000, 10_000)).toMatchObject({ severity: "high" });
  });

  it("falls back to the default for a value outside 10 to 10,000, never silencing the burst", () => {
    for (const bad of [0, 9, 10_001, 1e9, 50.5, Number.NaN, Infinity]) {
      expect(burst(100, bad), String(bad)).toMatchObject({ severity: "high", evidence: { burstThreshold: RPC_BURST_HITS } });
    }
    expect([isRpcBurstHits(RPC_BURST_MIN), isRpcBurstHits(RPC_BURST_MAX), isRpcBurstHits(9), isRpcBurstHits("100")]).toEqual([true, true, false, false]);
  });

  it("is passed through scan()", () => {
    const ctx = { scope: SCOPE, networks: new ServiceRoleNetworks(), ownership: {}, anonDefiners: DEFINERS };
    expect(scan([anonCall({ hits: 150 })], { ...ctx, rpcBurstHits: 200 })[0]).toMatchObject({ severity: "medium" });
    expect(scan([anonCall({ hits: 150 })], { ...ctx, rpcBurstHits: 150 })[0]).toMatchObject({ severity: "high" });
    expect(scan([anonCall({ hits: 150 })], ctx)[0]).toMatchObject({ severity: "high" });
  });
});

describe("RPC exposure in incidents, explanations and alerts", () => {
  const findings = detectRpcExposure([anonCall({ hits: RPC_BURST_HITS })], DEFINERS);
  const { updates } = applyFindings(SCOPE, [], findings, new Date("2026-10-27T12:05:00Z"));
  const u = updates[0]!;

  it("opens one paging incident for a burst from one anon network", () => {
    expect(updates).toHaveLength(1);
    expect(u).toMatchObject({ notify: true, incident: { actor: "anon:asn:14061", severity: "high", detectors: ["rpc_exposure"] } });
  });

  it("builds whitelisted features, and the template passes the validator", () => {
    const features = buildFeatures(u.incident, u.findings);
    expect(features).toMatchObject({
      actorKind: "anon_key",
      signals: ["definer_rpc_call", "rpc_burst"],
      rpcExposure: {
        functions: ["grant_credits"], postureChecks: ["anon_security_definer_function_executable"], postureSeverities: ["medium"],
        methods: ["POST"], callerClasses: ["manual_tool"], networkTypes: ["hosting"], asns: [14061],
      },
    });
    const text = templateExplanation(features);
    expect(text.nextSteps[0]).toContain("`grant_credits`");
    expect(validateExplanation(text, features)).toEqual([]);
  });

  it("drops evidence values outside the whitelist", () => {
    const bad = { ...findings[0]!, evidence: { ...findings[0]!.evidence, function: "x; drop", postureCheck: "Free Text", method: "TRACE" } };
    expect(buildFeatures(u.incident, [bad]).rpcExposure).toMatchObject({ functions: [], postureChecks: [], methods: [] });
  });

  it("labels the detector, its signals and the anon actor", () => {
    expect(detectorLabel("rpc_exposure")).toBe("Anon calls to an exposed SECURITY DEFINER function");
    expect(signalLabel("rpc_burst")).not.toBe("rpc burst");
    expect(actorAlias("anon:asn:14061")).toBe("Signed-out callers (anon key) on AS14061");
  });
});
