import { describe, expect, it } from "vitest";
import { supabaseRestRootGet, supabaseRestRootUrl, type FetchLike } from "../src/scan/fetch.js";
import { supabaseHostInScope } from "../src/scan/scope.js";
import { scanClientCode } from "../src/scan/secrets.js";
import {
  exposedNames,
  MAX_LISTED,
  MAX_PROJECTS,
  probeAnonExposure,
  scanClientCodeWithAnonExposure,
  SupabaseClientCollector,
} from "../src/scan/supabaseExposure.js";

// Issue #139, decision 046. Every request goes to a fake fetch; nothing touches the network.

const APEX = "example.com";
const SITE = "https://example.com";
const REF = "abcdefghijklmnopqrst";
const REF2 = "zyxwvutsrqponmlkjihg";
const REF3 = "qqqqqrrrrrssssstttt1";
const ROOT = (ref: string) => `https://${ref}.supabase.co/rest/v1/`;

// Fake keys built at runtime, so no key-shaped literal sits in the file for gitleaks to flag.
let seed = 0x139;
function rand(n: number): string {
  const alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
  let out = "";
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    out += alphabet[(seed >>> 16) % alphabet.length];
  }
  return out;
}
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const jwt = (payload: Record<string, unknown>) =>
  [b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })), b64url(JSON.stringify(payload)), rand(43)].join(".");
const anon = (ref: string) => jwt({ iss: "supabase", ref, role: "anon", iat: 1700000000 });
const ANON = anon(REF);

interface FakeResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

function site(routes: Record<string, FakeResponse>) {
  const requests: { url: string; method: string; headers: Record<string, string>; redirect: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, method: init.method, headers: init.headers, redirect: init.redirect });
    const r = routes[url] ?? { status: 404, body: "not found", headers: { "content-type": "text/plain" } };
    const status = r.status ?? 200;
    const body = status >= 300 && status < 400 ? null : (r.body ?? "");
    return new Response(body, { status, headers: r.headers ?? {} });
  };
  const supabase = () => requests.filter((r) => r.url.includes("supabase.co"));
  return { fetchImpl, requests, supabase };
}

const html = (body: string) => ({ body, headers: { "content-type": "text/html; charset=utf-8" } });
const js = (body: string) => ({ body, headers: { "content-type": "application/javascript" } });
const openapi = (paths: Record<string, unknown>, extra: Record<string, unknown> = {}) => ({
  body: JSON.stringify({ swagger: "2.0", info: { title: "PostgREST" }, paths, ...extra }),
  headers: { "content-type": "application/openapi+json" },
});
const app = (code: string) => ({
  [`${SITE}/`]: html(`<script src="/app.js"></script>`),
  [`${SITE}/app.js`]: js(code),
});
const createClient = (ref: string, key: string) => `createClient("https://${ref}.supabase.co","${key}")`;

describe("supabaseHostInScope", () => {
  const named = new Set([REF]);

  it("accepts only <ref>.supabase.co for a ref the site names", () => {
    expect(supabaseHostInScope(`${REF}.supabase.co`, named)).toBe(true);
  });

  it.each([
    ["a ref the site does not name", `${REF2}.supabase.co`],
    ["a subdomain of the project host", `x.${REF}.supabase.co`],
    ["a look-alike", `${REF}.supabase.co.evil.test`],
    ["supabase.com", `${REF}.supabase.com`],
    ["supabase.in", `${REF}.supabase.in`],
    ["a trailing dot", `${REF}.supabase.co.`],
    ["a short ref", "abcdefghijklmnopqrs.supabase.co"],
    ["upper case", `${REF.toUpperCase()}.supabase.co`],
    ["the bare apex", "supabase.co"],
    ["the verified site", APEX],
  ])("refuses %s", (_label, host) => {
    expect(supabaseHostInScope(host, named)).toBe(false);
  });

  it("refuses everything when the site names no project", () => {
    expect(supabaseHostInScope(`${REF}.supabase.co`, new Set())).toBe(false);
  });
});

describe("supabaseRestRootUrl", () => {
  const named = new Set([REF]);

  it("accepts the PostgREST root and nothing else", () => {
    expect(supabaseRestRootUrl(ROOT(REF), named)?.toString()).toBe(ROOT(REF));
  });

  it.each([
    ["http", `http://${REF}.supabase.co/rest/v1/`, null],
    ["a table path", `https://${REF}.supabase.co/rest/v1/profiles`, null],
    ["an RPC path", `https://${REF}.supabase.co/rest/v1/rpc/f`, null],
    ["a query", `https://${REF}.supabase.co/rest/v1/?select=*`, null],
    ["a port", `https://${REF}.supabase.co:8443/rest/v1/`, null],
    ["credentials", `https://u:p@${REF}.supabase.co/rest/v1/`, null],
    ["the auth API", `https://${REF}.supabase.co/auth/v1/`, null],
    ["another project", ROOT(REF2), "out-of-scope"],
    ["the site", `${SITE}/rest/v1/`, "out-of-scope"],
  ])("refuses %s", (_label, url, want) => {
    expect(supabaseRestRootUrl(url, named)).toBe(want);
  });

  it("refuses a ref that is not a ref without a request", async () => {
    const s = site({});
    const out = await supabaseRestRootGet("../../evil", ANON, new Set(["../../evil"]), { fetchImpl: s.fetchImpl });
    expect(out).toMatchObject({ kind: "refused", reason: "bad-url" });
    expect(s.requests).toEqual([]);
  });
});

describe("exposedNames", () => {
  it("splits tables and views from functions and skips the root", () => {
    const names = exposedNames(JSON.stringify({ paths: { "/": {}, "/profiles": {}, "/orders": {}, "/rpc/get_stats": {} } }));
    expect(names).toEqual({
      relations: ["orders", "profiles"],
      relationCount: 2,
      functions: ["get_stats"],
      functionCount: 1,
      unsafeNames: 0,
      capped: false,
    });
  });

  it("drops unsafe names through safeName and counts them", () => {
    const names = exposedNames(JSON.stringify({ paths: { "/ok": {}, "/bad\nname": {}, [`/${"x".repeat(64)}`]: {}, "/rpc/\u0007": {} } }));
    expect(names?.relations).toEqual(["ok"]);
    expect(names?.relationCount).toBe(3);
    expect(names?.functions).toEqual([]);
    expect(names?.functionCount).toBe(1);
    expect(names?.unsafeNames).toBe(3);
  });

  it(`lists at most ${MAX_LISTED} names and counts them all`, () => {
    const paths = Object.fromEntries(Array.from({ length: 150 }, (_, i) => [`/t${String(i).padStart(3, "0")}`, {}]));
    const names = exposedNames(JSON.stringify({ paths }));
    expect(names?.relations).toHaveLength(MAX_LISTED);
    expect(names?.relationCount).toBe(150);
  });

  it.each([
    ["not JSON", "<html>"],
    ["a cut-off document", '{"paths":{"/a":'],
    ["an array", "[]"],
    ["no paths", '{"swagger":"2.0"}'],
    ["paths as an array", '{"paths":["/a"]}'],
    ["null", "null"],
  ])("returns null for %s", (_label, text) => {
    expect(exposedNames(text)).toBeNull();
  });
});

describe("SupabaseClientCollector", () => {
  it("pairs a project URL with an anon key for the same ref, across files", () => {
    const c = new SupabaseClientCollector();
    c.add(`const url = "https://${REF}.supabase.co";`);
    c.add(`const key = "${ANON}";`);
    expect(c.pairs()).toEqual([{ ref: REF, anonKey: ANON }]);
  });

  it.each([
    ["a URL without a key", `"https://${REF}.supabase.co"`],
    ["a key without a URL", `"${ANON}"`],
    ["a key for another project", createClient(REF, anon(REF2))],
    ["a service_role key", createClient(REF, jwt({ iss: "supabase", ref: REF, role: "service_role" }))],
    ["a key without a ref", createClient(REF, jwt({ iss: "supabase", role: "anon" }))],
    ["a look-alike host", `createClient("https://${REF}.supabase.co.evil.test","${ANON}")`],
    ["a custom domain", `createClient("https://api.example.com","${ANON}")`],
  ])("pairs nothing for %s", (_label, code) => {
    const c = new SupabaseClientCollector();
    c.add(code);
    expect(c.pairs()).toEqual([]);
  });
});

describe("scanClientCodeWithAnonExposure", () => {
  it("sends one GET to the PostgREST root and records names and counts, never the key", async () => {
    const s = site({
      ...app(createClient(REF, ANON)),
      [ROOT(REF)]: openapi({ "/": {}, "/profiles": {}, "/orders": {}, "/rpc/get_stats": {} }, { definitions: { profiles: { properties: { email: {} } } } }),
    });
    const out = await scanClientCodeWithAnonExposure(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });

    expect(s.supabase()).toHaveLength(1);
    const req = s.supabase()[0]!;
    expect(req).toMatchObject({ url: ROOT(REF), method: "GET", redirect: "manual" });
    expect(req.headers.apikey).toBe(ANON);
    expect(req.headers.authorization).toBe(`Bearer ${ANON}`);
    expect(req.headers.prefer).toBeUndefined();

    expect(out.exposure).toEqual([{ ref: REF, outcome: "exposed" }]);
    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      severity: "medium",
      type: "anon-key-exposure:openapi",
      endpoint: ROOT(REF),
      supahoundMonitor: "exposed_read",
      evidence: {
        projectRef: REF,
        relationCount: 2,
        relationNames: ["orders", "profiles"],
        functionCount: 1,
        functionNames: ["get_stats"],
        last4: ANON.slice(-4),
      },
    });
    expect(out.findings[0]!.evidence.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(out.findings[0]!.fix).toMatch(/row level security/);
    // The key never reaches the result; neither do column names from the definitions.
    expect(JSON.stringify(out)).not.toContain(ANON);
    expect(JSON.stringify(out)).not.toContain(ANON.split(".")[2]!);
    expect(JSON.stringify(out)).not.toContain("email");
  });

  it("rates functions alone as low", async () => {
    const s = site({ ...app(createClient(REF, ANON)), [ROOT(REF)]: openapi({ "/": {}, "/rpc/hello": {} }) });
    const out = await scanClientCodeWithAnonExposure(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(out.findings.map((f) => f.severity)).toEqual(["low"]);
  });

  it("scanClientCode alone never contacts Supabase (the gate)", async () => {
    const s = site({ ...app(createClient(REF, ANON)), [ROOT(REF)]: openapi({ "/profiles": {} }) });
    const out = await scanClientCode(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(out.findings).toEqual([]);
    expect(s.supabase()).toEqual([]);
  });

  it("sends nothing to Supabase when the key belongs to another project", async () => {
    const s = site(app(createClient(REF, anon(REF2))));
    const out = await scanClientCodeWithAnonExposure(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(s.supabase()).toEqual([]);
    expect(out.exposure).toEqual([]);
  });

  it("never reads a third-party script for a key", async () => {
    const s = site({
      [`${SITE}/`]: html(`<script>const u="https://${REF}.supabase.co"</script><script src="https://cdn.vendor.test/k.js"></script>`),
      "https://cdn.vendor.test/k.js": js(`"${ANON}"`),
    });
    const out = await scanClientCodeWithAnonExposure(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(s.requests.map((r) => r.url)).toEqual([`${SITE}/`]);
    expect(out.exposure).toEqual([]);
  });

  it("sends no request when the target is outside the verified apex", async () => {
    const s = site({});
    await expect(scanClientCodeWithAnonExposure("https://evil.test/", APEX, { fetchImpl: s.fetchImpl })).rejects.toThrow();
    expect(s.requests).toEqual([]);
  });

  it(`probes at most ${MAX_PROJECTS} projects, one request each`, async () => {
    const code = [REF, REF2, REF3].map((r) => createClient(r, anon(r))).join(";") + ";" + createClient(REF, ANON);
    const s = site({ ...app(code), [ROOT(REF)]: openapi({}), [ROOT(REF2)]: openapi({}), [ROOT(REF3)]: openapi({}) });
    const out = await scanClientCodeWithAnonExposure(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    const urls = s.supabase().map((r) => r.url);
    expect(urls).toHaveLength(MAX_PROJECTS);
    expect(new Set(urls).size).toBe(urls.length);
    expect(out.exposure.every((c) => c.outcome === "nothing-exposed")).toBe(true);
    expect(out.findings).toEqual([]);
  });
});

describe("probeAnonExposure outcomes", () => {
  const collector = () => {
    const c = new SupabaseClientCollector();
    c.add(createClient(REF, ANON));
    return c;
  };

  it("does not follow a redirect from the root", async () => {
    const s = site({ [ROOT(REF)]: { status: 302, headers: { location: ROOT(REF) } } });
    const out = await probeAnonExposure(collector(), { fetchImpl: s.fetchImpl, limits: { maxRedirects: 3 } });
    expect(s.requests).toHaveLength(1);
    expect(out).toEqual({ findings: [], checks: [{ ref: REF, outcome: "refused", reason: "too-many-redirects" }] });
  });

  it("reports an oversized document without parsing it", async () => {
    const paths = Object.fromEntries(Array.from({ length: 50 }, (_, i) => [`/t${i}`, {}]));
    const s = site({ [ROOT(REF)]: openapi(paths) });
    const out = await probeAnonExposure(collector(), { fetchImpl: s.fetchImpl, limits: { maxBytes: 200 } });
    expect(s.requests).toHaveLength(1);
    expect(out).toEqual({ findings: [], checks: [{ ref: REF, outcome: "too-large" }] });
  });

  it("reports a malformed document", async () => {
    const s = site({ [ROOT(REF)]: { body: "<html>nope</html>", headers: { "content-type": "text/html" } } });
    const out = await probeAnonExposure(collector(), { fetchImpl: s.fetchImpl });
    expect(out).toEqual({ findings: [], checks: [{ ref: REF, outcome: "unreadable" }] });
  });

  it.each([401, 403])("reports %i as denied", async (status) => {
    const s = site({ [ROOT(REF)]: { status, body: "{}" } });
    const out = await probeAnonExposure(collector(), { fetchImpl: s.fetchImpl });
    expect(out).toEqual({ findings: [], checks: [{ ref: REF, outcome: "denied", reason: `http ${status}` }] });
  });

  it("reports a timeout", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal?.reason)));
    const out = await probeAnonExposure(collector(), { fetchImpl: hang, limits: { timeoutMs: 20 } });
    expect(out).toEqual({ findings: [], checks: [{ ref: REF, outcome: "failed", reason: "timeout" }] });
  });
});
