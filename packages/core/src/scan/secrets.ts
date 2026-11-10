// The secrets scanner for the scan funnel (hackme.si, decision 026).
//
// Two entry points, so the funnel can run one without the other:
//   scanClientCode  — the page, its same-apex scripts and their public source maps. Passive: it
//                     reads only what a browser loading the page would read.
//   probeLeakPaths  — one GET for each path on a fixed list (`/.env`, `/.git/config`, ...).
// Every request goes through `scopedGet`, so every URL and redirect hop passes the scope guard.
//
// Evidence never holds a secret: rule id, URL, a SHA-256 fingerprint and the last four characters.
// For an exposed `.env` file it holds the key names, never the values.

import { fingerprint, type EvidenceValue } from "../detectors/finding.js";
import { reportUrl, resolveLimits, scannableUrl, scopedGet, type ScopedFetchOptions } from "./fetch.js";

export type ScanSeverity = "critical" | "high" | "medium" | "low" | "info";

const RANK: Record<ScanSeverity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

// One row for `supahound.scan_findings`, without the ids the repository adds.
export interface ScanFindingInput {
  severity: ScanSeverity;
  type: string;
  endpoint: string;
  evidence: Record<string, EvidenceValue | string[]>;
  fix: string;
  supahoundMonitor: string | null;
}

export type SecretSource = "page" | "script" | "source-map" | "leak-path";

interface Accepted {
  severity?: ScanSeverity;
  extra?: Record<string, EvidenceValue>;
}

export interface SecretRule {
  id: string;
  name: string;
  severity: ScanSeverity;
  // Must be global. When `secretGroup` is set, that group is the secret; otherwise the whole match.
  pattern: RegExp;
  secretGroup?: number;
  fix: string;
  monitor?: string;
  // A second check on the secret. Return null to reject the match.
  accept?: (secret: string) => Accepted | null;
}

const ROTATE =
  "Revoke and rotate this credential at its provider, then remove it from the files the site serves. " +
  "Keep it in a server-side environment variable.";

// The payload of a JWT, or null when the token does not decode to a JSON object.
export function jwtPayload(token: string): Record<string, unknown> | null {
  const part = token.split(".")[1];
  if (part === undefined) return null;
  try {
    const b64 = part.replace(/-/g, "+").replace(/_/g, "/");
    const value: unknown = JSON.parse(atob(b64 + "=".repeat((4 - (b64.length % 4)) % 4)));
    return typeof value === "object" && value !== null && !Array.isArray(value) ? (value as Record<string, unknown>) : null;
  } catch {
    return null;
  }
}

// Rules are prefix-anchored, so a random string does not match. Each has a near-miss test.
export const SECRET_RULES: SecretRule[] = [
  {
    id: "supabase-service-role-key",
    name: "Supabase service_role key",
    severity: "critical",
    pattern: /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g,
    // A JWT is a finding only when it is a service_role key. An anon key belongs in client code.
    accept: (token) => {
      const payload = jwtPayload(token);
      if (payload?.role !== "service_role") return null;
      const ref = typeof payload.ref === "string" && /^[a-z0-9]{20}$/.test(payload.ref) ? payload.ref : null;
      return { extra: { projectRef: ref } };
    },
    fix:
      "Rotate the service_role key now (Supabase dashboard, Project Settings, API keys), then remove it from client code. " +
      "The key bypasses every RLS policy. Client code uses the anon or publishable key only.",
    monitor: "service_role_misuse",
  },
  {
    id: "supabase-secret-key",
    name: "Supabase secret API key",
    severity: "critical",
    pattern: /\bsb_secret_[A-Za-z0-9_-]{20,}/g,
    fix:
      "Delete this secret key in the Supabase dashboard (Project Settings, API keys) and create a new one. " +
      "Client code uses an sb_publishable_ key.",
    monitor: "service_role_misuse",
  },
  {
    id: "supabase-access-token",
    name: "Supabase personal access token",
    severity: "critical",
    pattern: /\bsbp_(?:oauth_)?[a-f0-9]{40}\b/g,
    fix: "Revoke this token in your Supabase account settings. It reaches the Management API of every project the account can open.",
  },
  {
    id: "postgres-url-with-password",
    name: "Postgres connection string with a password",
    severity: "critical",
    pattern: /\bpostgres(?:ql)?:\/\/[^:@/\s'"`]+:([^@/\s'"`]{6,})@[^\s'"`]+/g,
    secretGroup: 1,
    accept: (password) => (/^(?:postgres|password|secret|test|pass|changeme|\[YOUR-PASSWORD\])$/i.test(password) ? null : {}),
    fix: "Reset the database password, then remove the connection string from the files the site serves.",
  },
  {
    id: "private-key",
    name: "Private key",
    severity: "critical",
    pattern: /-----BEGIN (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----[\s\S]{32,8000}?-----END (?:RSA |EC |DSA |OPENSSH |ENCRYPTED )?PRIVATE KEY-----/g,
    fix: "Treat the key as compromised: revoke it, issue a new one, and keep it out of the files the site serves.",
  },
  {
    id: "stripe-secret-key",
    name: "Stripe live secret key",
    severity: "critical",
    pattern: /\bsk_live_[A-Za-z0-9]{20,}/g,
    fix: "Roll this key in the Stripe Dashboard (Developers, API keys). Client code uses only the publishable key (pk_live_).",
  },
  {
    id: "stripe-restricted-key",
    name: "Stripe live restricted key",
    severity: "high",
    pattern: /\brk_live_[A-Za-z0-9]{20,}/g,
    fix: "Roll this restricted key in the Stripe Dashboard (Developers, API keys).",
  },
  {
    id: "stripe-test-secret-key",
    name: "Stripe test secret key",
    severity: "low",
    pattern: /\bsk_test_[A-Za-z0-9]{20,}/g,
    fix: "Roll this test key in the Stripe Dashboard. It moves no real money, but it reads and writes your test data.",
  },
  {
    id: "stripe-webhook-secret",
    name: "Stripe webhook signing secret",
    severity: "high",
    pattern: /\bwhsec_[A-Za-z0-9+/=]{24,}/g,
    fix: "Roll the signing secret for this webhook endpoint in the Stripe Dashboard. Anyone with it can forge webhook events.",
  },
  {
    id: "openai-api-key",
    name: "OpenAI API key",
    severity: "high",
    pattern: /\bsk-(?:(?:proj|svcacct|admin)-[A-Za-z0-9_-]{40,}|[A-Za-z0-9]{20}T3BlbkFJ[A-Za-z0-9]{20})/g,
    fix: ROTATE,
  },
  {
    id: "anthropic-api-key",
    name: "Anthropic API key",
    severity: "high",
    pattern: /\bsk-ant-(?:api|admin)\d{2}-[A-Za-z0-9_-]{80,}/g,
    fix: ROTATE,
  },
  {
    id: "vercel-ai-gateway-key",
    name: "Vercel AI Gateway key",
    severity: "high",
    pattern: /\bvck_[A-Za-z0-9]{40,}/g,
    fix: ROTATE,
  },
  {
    id: "aws-access-key-id",
    name: "AWS access key ID",
    severity: "high",
    pattern: /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,
    fix: "Deactivate this access key in AWS IAM and create a new one. Its secret key is probably exposed with it.",
  },
  {
    id: "github-token",
    name: "GitHub token",
    severity: "high",
    pattern: /\b(?:gh[pousr]_[A-Za-z0-9]{36}|github_pat_[A-Za-z0-9_]{80,})\b/g,
    fix: "Revoke this token in GitHub (Settings, Developer settings).",
  },
  {
    id: "slack-token",
    name: "Slack token",
    severity: "high",
    pattern: /\bxox[abposr]-[A-Za-z0-9-]{20,}/g,
    fix: ROTATE,
  },
  {
    id: "sendgrid-api-key",
    name: "SendGrid API key",
    severity: "high",
    pattern: /\bSG\.[A-Za-z0-9_-]{22}\.[A-Za-z0-9_-]{43}\b/g,
    fix: ROTATE,
  },
];

// Documentation placeholders and obvious fakes. A real key is random; these are not.
export function looksLikePlaceholder(secret: string): boolean {
  if (/x{5,}|\*{4,}|REPLACE|your[_-]|example|placeholder|dummy|changeme|<[^>]+>/i.test(secret)) return true;
  // The tail skips the fixed prefix (`sk_live_`); a random tail of 16 has far more than 6 symbols.
  return secret.length >= 24 && new Set(secret.slice(-16)).size < 6;
}

export interface SecretMatch {
  rule: SecretRule;
  severity: ScanSeverity;
  fingerprint: string;
  last4: string;
  offset: number;
  extra: Record<string, EvidenceValue>;
}

// Every rule match in one text. Pure: it never logs and never returns the secret itself.
export function matchSecrets(text: string, rules: SecretRule[] = SECRET_RULES): SecretMatch[] {
  const out: SecretMatch[] = [];
  for (const rule of rules) {
    for (const m of text.matchAll(rule.pattern)) {
      const secret = rule.secretGroup === undefined ? m[0] : m[rule.secretGroup];
      if (secret === undefined || looksLikePlaceholder(secret)) continue;
      const accepted = rule.accept ? rule.accept(secret) : {};
      if (accepted === null) continue;
      out.push({
        rule,
        severity: accepted.severity ?? rule.severity,
        fingerprint: fingerprint(secret),
        last4: secret.replace(/-----END [A-Z ]*-----$/, "").trimEnd().slice(-4),
        offset: m.index ?? 0,
        extra: accepted.extra ?? {},
      });
    }
  }
  return out;
}

// Collects findings across many files. The same secret in ten chunks is one finding.
class FindingSet {
  private readonly byKey = new Map<string, ScanFindingInput>();

  addSecrets(matches: SecretMatch[], url: string, source: SecretSource): void {
    for (const m of matches) {
      const key = `secret:${m.rule.id}:${m.fingerprint}`;
      const seen = this.byKey.get(key);
      if (seen) {
        seen.evidence.occurrences = (seen.evidence.occurrences as number) + 1;
        continue;
      }
      this.byKey.set(key, {
        severity: m.severity,
        type: `exposed-secret:${m.rule.id}`,
        endpoint: reportUrl(url),
        evidence: {
          rule: m.rule.id,
          name: m.rule.name,
          source,
          fingerprint: m.fingerprint,
          last4: m.last4,
          offset: m.offset,
          occurrences: 1,
          ...m.extra,
        },
        fix: m.rule.fix,
        supahoundMonitor: m.rule.monitor ?? null,
      });
    }
  }

  addFile(finding: ScanFindingInput): void {
    this.byKey.set(`file:${finding.endpoint}`, finding);
  }

  list(): ScanFindingInput[] {
    return [...this.byKey.values()].sort((a, b) => RANK[b.severity] - RANK[a.severity]);
  }
}

export interface SkippedUrl {
  url: string;
  reason: "third-party" | "limit" | "out-of-scope" | "bad-url" | "too-many-redirects";
}

export interface ScanError {
  url: string;
  reason: string;
}

export interface SecretsScanResult {
  findings: ScanFindingInput[];
  fetched: string[];
  skipped: SkippedUrl[];
  errors: ScanError[];
}

// ---- Client code ------------------------------------------------------------------------------

const SCRIPT_SRC = /<script\b[^>]*?\bsrc\s*=\s*(?:"([^"]+)"|'([^']+)'|([^\s"'>]+))/gi;
const LINK_TAG = /<link\b[^>]*>/gi;
const ATTR = (name: string) => new RegExp(`\\b${name}\\s*=\\s*(?:"([^"]*)"|'([^']*)'|([^\\s"'>]+))`, "i");
// Script paths an app's own code names: absolute or relative `.js` paths, and Next.js chunk paths.
const SCRIPT_REF = /["'`]((?:\.{1,2}\/|\/)[A-Za-z0-9_\-./~%@]+?\.m?js|static\/chunks\/[A-Za-z0-9_\-./~%@]+?\.js)["'`]/g;
const SOURCE_MAP = /[#@]\s*sourceMappingURL=([^\s'"*]+)\s*(?:\*\/)?\s*$/;

function attr(tag: string, name: string): string | null {
  const m = ATTR(name).exec(tag);
  return m ? (m[1] ?? m[2] ?? m[3] ?? null) : null;
}

// Script URLs a page loads: <script src>, and <link> tags that preload a script.
export function scriptUrlsInHtml(html: string): string[] {
  const out: string[] = [];
  for (const m of html.matchAll(SCRIPT_SRC)) {
    const src = m[1] ?? m[2] ?? m[3];
    if (src) out.push(src);
  }
  for (const m of html.matchAll(LINK_TAG)) {
    const rel = (attr(m[0], "rel") ?? "").toLowerCase();
    const as = (attr(m[0], "as") ?? "").toLowerCase();
    const href = attr(m[0], "href");
    if (href && (rel.includes("modulepreload") || (rel.includes("preload") && as === "script"))) out.push(href);
  }
  return out;
}

// Script paths named inside a page or script, resolved against the file that names them.
export function scriptRefsInCode(code: string, fileUrl: string): string[] {
  const out: string[] = [];
  for (const m of code.matchAll(SCRIPT_REF)) {
    const ref = m[1]!;
    try {
      out.push(ref.startsWith("static/chunks/") ? new URL(`/_next/${ref}`, fileUrl).toString() : new URL(ref, fileUrl).toString());
    } catch {
      // Not a URL: skip.
    }
  }
  return out;
}

export function sourceMapUrl(code: string, fileUrl: string): string | null {
  const m = SOURCE_MAP.exec(code.slice(-2000));
  if (!m || m[1]!.startsWith("data:")) return null;
  try {
    return new URL(m[1]!, fileUrl).toString();
  } catch {
    return null;
  }
}

function isHtml(contentType: string, text: string): boolean {
  return contentType.includes("text/html") || /^\s*<(?:!doctype|html|head|body)\b/i.test(text);
}

// Reads the page at `targetUrl`, every same-apex script it loads or names, and each script's public
// source map, and matches every file against the rules. A script on another host is skipped, not
// fetched. Throws only when `targetUrl` itself is outside the verified apex.
export async function scanClientCode(targetUrl: string, verifiedApex: string, opts: ScopedFetchOptions = {}): Promise<SecretsScanResult> {
  const start = scannableUrl(targetUrl, verifiedApex);
  if (start === null || start === "out-of-scope") {
    throw new Error(`${reportUrl(targetUrl) || "the target"} is not a scannable URL inside ${verifiedApex}`);
  }
  const limits = resolveLimits(opts.limits);
  const findings = new FindingSet();
  const result: Omit<SecretsScanResult, "findings"> = { fetched: [], skipped: [], errors: [] };

  const page = await scopedGet(start.toString(), verifiedApex, opts);
  if (page.kind !== "ok") {
    if (page.kind === "failed") result.errors.push({ url: page.url, reason: page.reason });
    else result.skipped.push({ url: page.url, reason: page.reason });
    return { findings: [], ...result };
  }
  result.fetched.push(reportUrl(page.url));
  findings.addSecrets(matchSecrets(page.text), page.url, "page");

  // Breadth first: the page's own scripts before the chunks they name.
  const queue: { url: string; source: "script" | "source-map" }[] = [];
  const seen = new Set<string>([reportUrl(page.url)]);
  const enqueue = (raw: string, source: "script" | "source-map", base: string) => {
    const u = scannableUrl(raw, verifiedApex, base);
    if (u === null) return;
    const key = reportUrl(u === "out-of-scope" ? new URL(raw, base).toString() : u.toString());
    if (seen.has(key)) return;
    seen.add(key);
    if (u === "out-of-scope") result.skipped.push({ url: key, reason: "third-party" });
    else queue.push({ url: u.toString(), source });
  };
  for (const src of scriptUrlsInHtml(page.text)) enqueue(src, "script", page.url);
  for (const ref of scriptRefsInCode(page.text, page.url)) enqueue(ref, "script", page.url);

  let budget = limits.maxScripts;
  while (queue.length > 0) {
    const next = queue.shift()!;
    if (budget <= 0) {
      result.skipped.push({ url: reportUrl(next.url), reason: "limit" });
      continue;
    }
    budget--;
    const doc = await scopedGet(next.url, verifiedApex, opts);
    if (doc.kind === "failed") {
      result.errors.push({ url: doc.url, reason: doc.reason });
      continue;
    }
    if (doc.kind === "refused") {
      result.skipped.push({ url: doc.url, reason: doc.reason });
      continue;
    }
    if (doc.status !== 200 || isHtml(doc.contentType, doc.text)) continue; // A 404 page or SPA shell.
    result.fetched.push(reportUrl(doc.url));
    findings.addSecrets(matchSecrets(doc.text), doc.url, next.source);
    if (next.source === "script") {
      const map = sourceMapUrl(doc.text, doc.url);
      if (map) enqueue(map, "source-map", doc.url);
      for (const ref of scriptRefsInCode(doc.text, doc.url)) enqueue(ref, "script", doc.url);
    }
  }

  return { findings: findings.list(), ...result };
}

// ---- Leak paths -------------------------------------------------------------------------------

type LeakKind = "env" | "npmrc" | "git-config" | "git-head" | "aws-credentials";

// The fixed list (decision 026). One GET each; no guessing, no recursion, no `.git/objects`.
export const LEAK_PATHS: readonly { path: string; kind: LeakKind }[] = [
  { path: "/.env", kind: "env" },
  { path: "/.env.local", kind: "env" },
  { path: "/.env.production", kind: "env" },
  { path: "/.env.production.local", kind: "env" },
  { path: "/.env.development", kind: "env" },
  { path: "/.npmrc", kind: "npmrc" },
  { path: "/.git/config", kind: "git-config" },
  { path: "/.git/HEAD", kind: "git-head" },
  { path: "/.aws/credentials", kind: "aws-credentials" },
];

const ENV_LINE = /^\s*(?:export\s+)?([A-Za-z_][A-Za-z0-9_.]*)\s*=/;
const NPMRC_LINE = /^\s*([^#;\s=][^=]*?)\s*=/;

function meaningfulLines(text: string): string[] {
  return text.split(/\r?\n/).filter((l) => l.trim() !== "" && !/^\s*[#;]/.test(l));
}

// The key names of a KEY=VALUE file, or null when most lines are not KEY=VALUE. Values are dropped.
export function keyValueNames(text: string, line: RegExp): string[] | null {
  const lines = meaningfulLines(text);
  if (lines.length === 0) return null;
  const names: string[] = [];
  for (const l of lines) {
    const m = line.exec(l);
    if (m) names.push(m[1]!.slice(0, 64));
  }
  return names.length > 0 && names.length * 2 >= lines.length ? names : null;
}

interface LeakShape {
  severity: ScanSeverity;
  evidence: Record<string, EvidenceValue | string[]>;
  fix: string;
}

const BLOCK_DOTFILES = "Block every path that starts with a dot at your host or CDN, and remove the file from the deployed build.";

// Whether a response body has the real shape of the file at that path. An SPA serves its HTML shell
// with status 200 for any path; that shell never passes.
export function leakShape(kind: LeakKind, text: string): LeakShape | null {
  switch (kind) {
    case "env":
    case "npmrc": {
      const names = keyValueNames(text, kind === "env" ? ENV_LINE : NPMRC_LINE);
      if (!names) return null;
      // npmrc keys hold registry URLs; keep only the part after the last colon (`_authToken`).
      const keys = kind === "npmrc" ? names.map((n) => n.split(":").pop()!.slice(0, 64)) : names;
      return {
        severity: "high",
        evidence: { keyCount: keys.length, keyNames: [...new Set(keys)].slice(0, 50) },
        fix: `Anyone can download this file. Rotate every credential it holds. ${BLOCK_DOTFILES}`,
      };
    }
    case "git-config":
      if (!/^\s*\[core\]/m.test(text) || !/repositoryformatversion/.test(text)) return null;
      return {
        severity: "high",
        evidence: { hasRemote: /^\s*\[remote /m.test(text) },
        fix: `The .git directory is public, so your source code and its history can be downloaded. ${BLOCK_DOTFILES}`,
      };
    case "git-head":
      if (!/^(?:ref: refs\/[^\s]+|[0-9a-f]{40})\s*$/.test(text.trim())) return null;
      return {
        severity: "high",
        evidence: {},
        fix: `The .git directory is public, so your source code and its history can be downloaded. ${BLOCK_DOTFILES}`,
      };
    case "aws-credentials":
      if (!/^\s*\[[^\]\n]+\]/m.test(text) || !/aws_access_key_id\s*=/i.test(text)) return null;
      return {
        severity: "critical",
        evidence: { profiles: (text.match(/^\s*\[[^\]\n]+\]/gm) ?? []).length },
        fix: `Deactivate every access key in this file in AWS IAM. ${BLOCK_DOTFILES}`,
      };
  }
}

// One GET for each path on the fixed list, at the target's origin. A response is a finding only
// when it is a 200 at the same path (not a redirect elsewhere), is not HTML, and has the file's
// shape. Secrets inside the file are reported as their own findings.
export async function probeLeakPaths(targetUrl: string, verifiedApex: string, opts: ScopedFetchOptions = {}): Promise<SecretsScanResult> {
  const start = scannableUrl(targetUrl, verifiedApex);
  if (start === null || start === "out-of-scope") {
    throw new Error(`${reportUrl(targetUrl) || "the target"} is not a scannable URL inside ${verifiedApex}`);
  }
  const findings = new FindingSet();
  const result: Omit<SecretsScanResult, "findings"> = { fetched: [], skipped: [], errors: [] };

  for (const { path, kind } of LEAK_PATHS) {
    const url = new URL(path, start.origin).toString();
    const doc = await scopedGet(url, verifiedApex, opts);
    if (doc.kind === "failed") {
      result.errors.push({ url: doc.url, reason: doc.reason });
      continue;
    }
    if (doc.kind === "refused") {
      result.skipped.push({ url: doc.url, reason: doc.reason });
      continue;
    }
    result.fetched.push(reportUrl(url));
    if (doc.status !== 200 || new URL(doc.url).pathname !== path || isHtml(doc.contentType, doc.text)) continue;
    const shape = leakShape(kind, doc.text);
    if (!shape) continue;
    findings.addFile({
      severity: shape.severity,
      type: `exposed-file:${kind}`,
      endpoint: reportUrl(url),
      evidence: { path, ...shape.evidence },
      fix: shape.fix,
      supahoundMonitor: null,
    });
    findings.addSecrets(matchSecrets(doc.text), url, "leak-path");
  }

  return { findings: findings.list(), ...result };
}
