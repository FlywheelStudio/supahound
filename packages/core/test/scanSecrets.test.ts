import { describe, expect, it } from "vitest";
import { SCANNER_USER_AGENT, scopedGet, type FetchLike } from "../src/scan/fetch.js";
import {
  jwtPayload,
  keyValueNames,
  LEAK_PATHS,
  leakShape,
  matchSecrets,
  probeLeakPaths,
  scanClientCode,
  scriptRefsInCode,
  scriptUrlsInHtml,
  SECRET_RULES,
  sourceMapUrl,
} from "../src/scan/secrets.js";

const APEX = "example.com";
const SITE = "https://example.com";

// ---- Fake secrets ------------------------------------------------------------------------------
// Built at runtime from parts, so no key-shaped literal sits in the file for gitleaks to flag.

let seed = 0x5eed;
function rand(n: number, alphabet = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789"): string {
  let out = "";
  for (let i = 0; i < n; i++) {
    seed = (Math.imul(seed, 1103515245) + 12345) >>> 0;
    out += alphabet[(seed >>> 16) % alphabet.length];
  }
  return out;
}
const hex = (n: number) => rand(n, "0123456789abcdef");
const upper = (n: number) => rand(n, "ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789");
const join = (...parts: string[]) => parts.join("");
const b64url = (s: string) => btoa(s).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
const REF = "abcdefghijklmnopqrst";
const jwt = (payload: Record<string, unknown>) =>
  [b64url(JSON.stringify({ alg: "HS256", typ: "JWT" })), b64url(JSON.stringify(payload)), rand(43)].join(".");

const SERVICE_ROLE = jwt({ iss: "supabase", ref: REF, role: "service_role", iat: 1700000000 });
const ANON = jwt({ iss: "supabase", ref: REF, role: "anon", iat: 1700000000 });
const STRIPE_LIVE = join("sk", "_live_", rand(32));
const PEM = join("-----BEGIN ", "PRIVATE KEY-----\n", rand(64), "\n", rand(64), "\n-----END ", "PRIVATE KEY-----");

const POSITIVES: [string, string][] = [
  ["supabase-service-role-key", SERVICE_ROLE],
  ["supabase-secret-key", join("sb", "_secret_", rand(32))],
  ["supabase-access-token", join("sb", "p_", hex(40))],
  ["postgres-url-with-password", join("postgres", "ql://postgres.", REF, ":", rand(20), "@aws-0.pooler.supabase.com:6543/postgres")],
  ["private-key", PEM],
  ["stripe-secret-key", STRIPE_LIVE],
  ["stripe-restricted-key", join("rk", "_live_", rand(32))],
  ["stripe-test-secret-key", join("sk", "_test_", rand(32))],
  ["stripe-webhook-secret", join("wh", "sec_", rand(32))],
  ["openai-api-key", join("sk", "-proj-", rand(60))],
  ["anthropic-api-key", join("sk", "-ant-api03-", rand(90))],
  ["vercel-ai-gateway-key", join("vc", "k_", rand(48))],
  ["aws-access-key-id", join("AK", "IA", upper(16))],
  ["github-token", join("gh", "p_", rand(36))],
  ["slack-token", join("xo", "xb-", rand(12), "-", rand(24))],
  ["sendgrid-api-key", join("SG", ".", rand(22), ".", rand(43))],
];

// Strings one step away from a real key, keyed by the rule they test. Each must produce no finding.
const NEAR_MISSES: [string, string, string][] = [
  ["supabase-service-role-key", "anon JWT", ANON],
  ["supabase-service-role-key", "JWT without a role", jwt({ iss: "supabase", ref: REF })],
  ["supabase-secret-key", "publishable Supabase key", join("sb", "_publishable_", rand(32))],
  ["supabase-secret-key", "secret key one short", join("sb", "_secret_", rand(19))],
  ["supabase-access-token", "access token with 39 hex", join("sb", "p_", hex(39))],
  ["postgres-url-with-password", "postgres URL with a default password", join("postgres", "://postgres:", "postgres", "@localhost:5432/db")],
  ["postgres-url-with-password", "postgres URL without a password", join("postgres", "://postgres@localhost:5432/db")],
  ["private-key", "public key block", join("-----BEGIN ", "PUBLIC KEY-----\n", rand(64), "\n-----END ", "PUBLIC KEY-----")],
  ["stripe-secret-key", "Stripe publishable key", join("pk", "_live_", rand(32))],
  ["stripe-secret-key", "short Stripe key", join("sk", "_live_", rand(19))],
  ["stripe-secret-key", "placeholder Stripe key", join("sk", "_live_", "x".repeat(24))],
  ["stripe-secret-key", "repeated-character key", join("sk", "_live_", "ab".repeat(16))],
  ["stripe-secret-key", "documented placeholder", join("sk", "_live_", "your_", rand(24))],
  ["stripe-restricted-key", "restricted key one short", join("rk", "_live_", rand(19))],
  ["stripe-test-secret-key", "test key one short", join("sk", "_test_", rand(19))],
  ["stripe-webhook-secret", "webhook secret one short", join("wh", "sec_", rand(23))],
  ["openai-api-key", "sk- key without the OpenAI marker", join("sk", "-", rand(48))],
  ["openai-api-key", "project key one short", join("sk", "-proj-", rand(39))],
  ["anthropic-api-key", "Anthropic prefix without a body", join("sk", "-ant-api03-", rand(20))],
  ["vercel-ai-gateway-key", "gateway key one short", join("vc", "k_", rand(39))],
  ["aws-access-key-id", "lowercase AWS key", join("ak", "ia", upper(16).toLowerCase())],
  ["aws-access-key-id", "AWS key one short", join("AK", "IA", upper(15))],
  ["github-token", "GitHub token one short", join("gh", "p_", rand(35))],
  ["github-token", "unknown GitHub prefix", join("gh", "x_", rand(36))],
  ["slack-token", "Slack token one short", join("xo", "xb-", rand(19))],
  ["sendgrid-api-key", "SendGrid key one short", join("SG", ".", rand(22), ".", rand(42))],
];

describe("matchSecrets", () => {
  it("has a positive sample for every rule", () => {
    expect(new Set(POSITIVES.map(([id]) => id))).toEqual(new Set(SECRET_RULES.map((r) => r.id)));
  });

  it("has a near miss for every rule", () => {
    expect(new Set(NEAR_MISSES.map(([id]) => id))).toEqual(new Set(SECRET_RULES.map((r) => r.id)));
  });

  it.each(POSITIVES)("matches %s", (id, secret) => {
    const found = matchSecrets(`const config = { key: "${secret}" };`);
    expect(found.map((m) => m.rule.id)).toEqual([id]);
  });

  it.each(NEAR_MISSES)("%s: does not match a %s", (_id, _label, text) => {
    expect(matchSecrets(`window.__ENV = "${text}";`)).toEqual([]);
  });

  it.each(POSITIVES)("never returns the %s itself", (_id, secret) => {
    const found = matchSecrets(`a="${secret}"`);
    const serialized = JSON.stringify(found.map(({ rule, ...rest }) => ({ rule: rule.id, ...rest })));
    expect(serialized).not.toContain(secret);
    expect(found[0]!.fingerprint).toMatch(/^[0-9a-f]{12}$/);
    expect(found[0]!.last4).toHaveLength(4);
  });

  it("reads the project ref from a service_role key", () => {
    const [m] = matchSecrets(SERVICE_ROLE);
    expect(m!.severity).toBe("critical");
    expect(m!.extra).toEqual({ projectRef: REF });
    expect(m!.rule.monitor).toBe("service_role_misuse");
  });

  it("finds a key in a JSON-escaped source map", () => {
    const map = JSON.stringify({ version: 3, sourcesContent: [`export const k = "${STRIPE_LIVE}";\n`] });
    expect(matchSecrets(map).map((m) => m.rule.id)).toEqual(["stripe-secret-key"]);
  });

  it("decodes a JWT payload and rejects junk", () => {
    expect(jwtPayload(SERVICE_ROLE)?.role).toBe("service_role");
    expect(jwtPayload("eyJ.not-base64!.x")).toBeNull();
    expect(jwtPayload("nodots")).toBeNull();
  });
});

// ---- A fake site -------------------------------------------------------------------------------

interface FakeResponse {
  status?: number;
  body?: string;
  headers?: Record<string, string>;
}

function site(routes: Record<string, FakeResponse>, fallback?: FakeResponse) {
  const requests: { url: string; method: string; ua: string | undefined; redirect: string }[] = [];
  const fetchImpl: FetchLike = async (url, init) => {
    requests.push({ url, method: init.method, ua: init.headers["user-agent"], redirect: init.redirect });
    const r = routes[url] ?? fallback ?? { status: 404, body: "not found", headers: { "content-type": "text/plain" } };
    const status = r.status ?? 200;
    const body = status >= 300 && status < 400 ? null : (r.body ?? "");
    return new Response(body, { status, headers: r.headers ?? {} });
  };
  return { fetchImpl, requests, urls: () => requests.map((r) => r.url) };
}

const html = (body: string) => ({ body, headers: { "content-type": "text/html; charset=utf-8" } });
const js = (body: string) => ({ body, headers: { "content-type": "application/javascript" } });
const text = (body: string) => ({ body, headers: { "content-type": "text/plain" } });
const redirect = (location: string) => ({ status: 302, headers: { location } });

describe("scopedGet", () => {
  it.each([
    ["https://evil.test/", "out-of-scope"],
    ["https://example.com.evil.test/", "out-of-scope"],
    ["ftp://example.com/x", "bad-url"],
    ["https://example.com:8443/", "bad-url"],
    ["https://user:pw@example.com/", "bad-url"],
    ["not a url", "bad-url"],
  ])("refuses %s without a request", async (url, reason) => {
    const s = site({});
    const out = await scopedGet(url, APEX, { fetchImpl: s.fetchImpl });
    expect(out).toMatchObject({ kind: "refused", reason });
    expect(s.requests).toEqual([]);
  });

  it("follows an in-scope redirect and names the scanner", async () => {
    const s = site({ "https://www.example.com/": redirect("https://example.com/"), [`${SITE}/`]: html("<p>hi</p>") });
    const out = await scopedGet("https://www.example.com/", APEX, { fetchImpl: s.fetchImpl });
    expect(out).toMatchObject({ kind: "ok", url: `${SITE}/`, status: 200 });
    expect(s.requests.every((r) => r.method === "GET" && r.redirect === "manual" && r.ua === SCANNER_USER_AGENT)).toBe(true);
  });

  it("never follows a redirect out of scope", async () => {
    const s = site({ [`${SITE}/`]: redirect("https://evil.test/steal") });
    const out = await scopedGet(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(out).toMatchObject({ kind: "refused", reason: "out-of-scope" });
    expect(s.urls()).toEqual([`${SITE}/`]);
  });

  it("stops after the redirect limit", async () => {
    const s = site({}, redirect("/again"));
    const out = await scopedGet(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl, limits: { maxRedirects: 2 } });
    expect(out).toMatchObject({ kind: "refused", reason: "too-many-redirects" });
    expect(s.requests).toHaveLength(3);
  });

  it("reads no more than maxBytes", async () => {
    const s = site({ [`${SITE}/big.js`]: js("a".repeat(5000)) });
    const out = await scopedGet(`${SITE}/big.js`, APEX, { fetchImpl: s.fetchImpl, limits: { maxBytes: 100 } });
    expect(out).toMatchObject({ kind: "ok", truncated: true });
    expect(out.kind === "ok" && out.text.length).toBe(100);
  });

  it("reports a timeout as a failure, not a throw", async () => {
    const hang: FetchLike = (_url, init) =>
      new Promise((_resolve, reject) => init.signal?.addEventListener("abort", () => reject(init.signal!.reason)));
    const out = await scopedGet(`${SITE}/`, APEX, { fetchImpl: hang, limits: { timeoutMs: 20 } });
    expect(out).toMatchObject({ kind: "failed", reason: "timeout" });
  });
});

describe("script discovery", () => {
  it("reads script tags and script preloads", () => {
    const page = `<script src="/a.js"></script><script type=module src='/b.js'></script><script src=/c.js></script>
      <link rel="modulepreload" href="/d.js"><link rel="preload" as="script" href="/e.js"><link rel="stylesheet" href="/s.css">`;
    expect(scriptUrlsInHtml(page)).toEqual(["/a.js", "/b.js", "/c.js", "/d.js", "/e.js"]);
  });

  it("resolves chunk paths named in code", () => {
    const code = `import("./lazy-1.js");x("/assets/b-2.mjs");y="static/chunks/app/page-3.js";z="/logo.svg"`;
    expect(scriptRefsInCode(code, `${SITE}/assets/index.js`)).toEqual([
      `${SITE}/assets/lazy-1.js`,
      `${SITE}/assets/b-2.mjs`,
      `${SITE}/_next/static/chunks/app/page-3.js`,
    ]);
  });

  it("finds an external source map and ignores an inline one", () => {
    expect(sourceMapUrl("x()\n//# sourceMappingURL=index.js.map\n", `${SITE}/assets/index.js`)).toBe(`${SITE}/assets/index.js.map`);
    expect(sourceMapUrl("x()\n//# sourceMappingURL=data:application/json;base64,e30=", `${SITE}/a.js`)).toBeNull();
  });
});

describe("scanClientCode", () => {
  it("finds a service_role key in a same-apex script and skips third-party hosts", async () => {
    const s = site({
      [`${SITE}/`]: html(`<script src="/assets/app.js?v=1"></script><script src="https://cdn.vendor.test/lib.js"></script>`),
      [`${SITE}/assets/app.js?v=1`]: js(`createClient("https://${REF}.supabase.co","${SERVICE_ROLE}")`),
    });
    const out = await scanClientCode(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });

    expect(out.findings).toHaveLength(1);
    expect(out.findings[0]).toMatchObject({
      severity: "critical",
      type: "exposed-secret:supabase-service-role-key",
      endpoint: `${SITE}/assets/app.js`, // query string dropped
      supahoundMonitor: "service_role_misuse",
      evidence: { source: "script", projectRef: REF, occurrences: 1 },
    });
    expect(out.skipped).toContainEqual({ url: "https://cdn.vendor.test/lib.js", reason: "third-party" });
    expect(s.urls().some((u) => u.includes("vendor.test"))).toBe(false);
    expect(JSON.stringify(out)).not.toContain(SERVICE_ROLE);
  });

  it("reports nothing for a page that ships only the anon key", async () => {
    const s = site({
      [`${SITE}/`]: html(`<script src="/app.js"></script>`),
      [`${SITE}/app.js`]: js(`createClient("https://${REF}.supabase.co","${ANON}")`),
    });
    const out = await scanClientCode(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(out.findings).toEqual([]);
    expect(out.fetched).toEqual([`${SITE}/`, `${SITE}/app.js`]);
  });

  it("follows chunks and source maps, and counts one secret once", async () => {
    const s = site({
      [`${SITE}/`]: html(`<script type="module" src="/assets/index.js"></script>`),
      [`${SITE}/assets/index.js`]: js(`import("./lazy.js");k="${STRIPE_LIVE}"\n//# sourceMappingURL=index.js.map`),
      [`${SITE}/assets/lazy.js`]: js(`k2="${STRIPE_LIVE}"`),
      [`${SITE}/assets/index.js.map`]: {
        body: JSON.stringify({ version: 3, sourcesContent: [`const pg = "${POSITIVES[3]![1]}";`] }),
        headers: { "content-type": "application/json" },
      },
    });
    const out = await scanClientCode(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });

    const stripe = out.findings.find((f) => f.type === "exposed-secret:stripe-secret-key");
    expect(stripe?.evidence.occurrences).toBe(2);
    const pg = out.findings.find((f) => f.type === "exposed-secret:postgres-url-with-password");
    expect(pg?.evidence.source).toBe("source-map");
    expect(s.urls()).toContain(`${SITE}/assets/lazy.js`);
  });

  it("stops at the script limit", async () => {
    const tags = Array.from({ length: 5 }, (_, i) => `<script src="/s${i}.js"></script>`).join("");
    const s = site({ [`${SITE}/`]: html(tags) }, js("ok()"));
    const out = await scanClientCode(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl, limits: { maxScripts: 2 } });
    expect(s.requests).toHaveLength(3);
    expect(out.skipped.filter((x) => x.reason === "limit")).toHaveLength(3);
  });

  it("does not scan an SPA shell served at a script URL", async () => {
    const s = site({ [`${SITE}/`]: html(`<script src="/gone.js"></script>`) }, html(`<html>${STRIPE_LIVE}</html>`));
    const out = await scanClientCode(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(out.findings).toEqual([]);
  });

  it("records a failed script and keeps going", async () => {
    const routes: Record<string, FakeResponse> = {
      [`${SITE}/`]: html(`<script src="/bad.js"></script><script src="/good.js"></script>`),
      [`${SITE}/good.js`]: js(`k="${STRIPE_LIVE}"`),
    };
    const base = site(routes);
    const fetchImpl: FetchLike = async (url, init) => {
      if (url.endsWith("/bad.js")) throw new TypeError("fetch failed");
      return base.fetchImpl(url, init);
    };
    const out = await scanClientCode(`${SITE}/`, APEX, { fetchImpl });
    expect(out.errors).toEqual([{ url: `${SITE}/bad.js`, reason: "network error" }]);
    expect(out.findings).toHaveLength(1);
  });

  it("refuses a target outside the verified apex", async () => {
    const s = site({});
    await expect(scanClientCode("https://evil.test/", APEX, { fetchImpl: s.fetchImpl })).rejects.toThrow(/not a scannable URL/);
    expect(s.requests).toEqual([]);
  });
});

describe("leak-path shapes", () => {
  it("keeps env key names and drops values", () => {
    expect(keyValueNames(`# comment\nexport API_URL=https://x\nSTRIPE_KEY = abc\n\n`, /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=/)).toEqual([
      "API_URL",
      "STRIPE_KEY",
    ]);
  });

  it.each([
    ["env", "<!doctype html><html><body>app</body></html>"],
    ["env", "Not Found"],
    ["env", "var a=1;function b(){return a}"],
    ["env", "status=404\nNot found"],
    ["npmrc", "Page not found. Try <a href=/>home</a>"],
    ["npmrc", "color=true\nfund=false"],
    ["git-config", "[user]\nname = x"],
    ["git-head", "<html>ref: refs/heads/main</html>"],
    ["aws-credentials", "[default]\nregion = us-east-1"],
  ] as const)("rejects a %s look-alike", (kind, body) => {
    expect(leakShape(kind, body)).toBeNull();
  });
});

describe("probeLeakPaths", () => {
  it("requests only the fixed list, with GET, at the target origin", async () => {
    const s = site({});
    const out = await probeLeakPaths(`${SITE}/pricing?x=1`, APEX, { fetchImpl: s.fetchImpl });
    expect(s.urls()).toEqual(LEAK_PATHS.map((p) => `${SITE}${p.path}`));
    expect(s.requests.every((r) => r.method === "GET")).toBe(true);
    expect(s.urls().some((u) => u.includes(".git/objects"))).toBe(false);
    expect(out.findings).toEqual([]);
  });

  it("reports nothing for an SPA that answers 200 to every path", async () => {
    const s = site({}, html(`<!doctype html><html><div id="root"></div><script>KEY=1</script></html>`));
    const out = await probeLeakPaths(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(out.findings).toEqual([]);
  });

  it("reports nothing for a catch-all that serves the shell as text/plain", async () => {
    const s = site({}, text(`<!DOCTYPE html>\n<html lang="en"><head></head></html>`));
    const out = await probeLeakPaths(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(out.findings).toEqual([]);
  });

  it("reports nothing when a leak path redirects to another page", async () => {
    const s = site({ [`${SITE}/.env`]: redirect("/login"), [`${SITE}/login`]: text("A=1\nB=2") });
    const out = await probeLeakPaths(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(out.findings).toEqual([]);
  });

  it("never follows a leak-path redirect out of scope", async () => {
    const s = site({ [`${SITE}/.env`]: redirect("https://evil.test/.env") });
    const out = await probeLeakPaths(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(out.skipped).toContainEqual({ url: `${SITE}/.env`, reason: "out-of-scope" });
    expect(s.urls().some((u) => u.includes("evil.test"))).toBe(false);
  });

  it("reports an exposed .env by key names, and its secrets on their own", async () => {
    const s = site({
      [`${SITE}/.env`]: text(`# prod\nNEXT_PUBLIC_SUPABASE_URL=https://${REF}.supabase.co\nSUPABASE_SERVICE_ROLE_KEY=${SERVICE_ROLE}\nSTRIPE_SECRET_KEY=${STRIPE_LIVE}\n`),
    });
    const out = await probeLeakPaths(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });

    expect(out.findings.map((f) => [f.severity, f.type])).toEqual([
      ["critical", "exposed-secret:supabase-service-role-key"],
      ["critical", "exposed-secret:stripe-secret-key"],
      ["high", "exposed-file:env"],
    ]);
    const file = out.findings.find((f) => f.type === "exposed-file:env")!;
    expect(file.evidence).toEqual({
      path: "/.env",
      keyCount: 3,
      keyNames: ["NEXT_PUBLIC_SUPABASE_URL", "SUPABASE_SERVICE_ROLE_KEY", "STRIPE_SECRET_KEY"],
    });
    const serialized = JSON.stringify(out);
    expect(serialized).not.toContain(SERVICE_ROLE);
    expect(serialized).not.toContain(STRIPE_LIVE);
    expect(serialized).not.toContain(`${REF}.supabase.co`);
  });

  it("reports an exposed .git directory and .npmrc", async () => {
    const s = site({
      [`${SITE}/.git/config`]: text(`[core]\n\trepositoryformatversion = 0\n[remote "origin"]\n\turl = git@github.com:acme/app.git\n`),
      [`${SITE}/.git/HEAD`]: text("ref: refs/heads/main\n"),
      [`${SITE}/.npmrc`]: text(`//registry.npmjs.org/:_authToken=${rand(36)}\n`),
    });
    const out = await probeLeakPaths(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(out.findings.map((f) => f.type).sort()).toEqual(["exposed-file:git-config", "exposed-file:git-head", "exposed-file:npmrc"]);
    expect(out.findings.find((f) => f.type === "exposed-file:git-config")!.evidence).toEqual({ path: "/.git/config", hasRemote: true });
    expect(out.findings.find((f) => f.type === "exposed-file:npmrc")!.evidence).toMatchObject({ keyNames: ["_authToken"] });
    expect(JSON.stringify(out)).not.toContain("acme/app");
  });

  it("reports a secret in a leak-path file that has no file shape", async () => {
    const s = site({ [`${SITE}/.env.local`]: text(`Not found\nhere is ${STRIPE_LIVE}\nbye`) });
    const out = await probeLeakPaths(`${SITE}/`, APEX, { fetchImpl: s.fetchImpl });
    expect(out.findings.map((f) => f.type)).toEqual(["exposed-secret:stripe-secret-key"]);
    expect(out.findings[0]!.evidence.source).toBe("leak-path");
  });

  it("refuses a target outside the verified apex", async () => {
    const s = site({});
    await expect(probeLeakPaths("https://evil.test/", APEX, { fetchImpl: s.fetchImpl })).rejects.toThrow(/not a scannable URL/);
    expect(s.requests).toEqual([]);
  });
});
