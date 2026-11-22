// What a site's Supabase anon key exposes (issue #139, decision 046).
//
// A Supabase app ships its project URL and anon key in client code; that is by design. The anon key
// reaches every table, view and function the `anon` role has a grant on, through the Data API, and
// PostgREST's root (`/rest/v1/`) lists them in an OpenAPI description, without reading a row.
//
// After the secrets scanner has read a verified site's client code, this module sends ONE GET to
// that root for each Supabase project the code names together with an anon key for the same
// project. It stores the exposed names (through `safeName`) and counts. It never reads rows, never
// sends HEAD or `Prefer: count` requests, never calls an RPC, never tries another key, and never
// stores the key: the finding holds its fingerprint and last four characters, as a secret finding
// does.

import { fingerprint } from "../detectors/finding.js";
import { safeName } from "../posture/catalog.js";
import { supabaseRestRootGet, type ScopedFetchOptions } from "./fetch.js";
import { SUPABASE_REF } from "./scope.js";
import {
  jwtPayload,
  looksLikePlaceholder,
  scanClientCode,
  type ScanFindingInput,
  type ScanSeverity,
  type SecretsScanResult,
} from "./secrets.js";

// At most this many projects per scan. A site normally names one; the cap bounds the requests a
// hostile page could make the scanner send by naming many.
export const MAX_PROJECTS = 2;
// Names listed per kind. The counts cover them all.
export const MAX_LISTED = 100;
// Paths read from one OpenAPI document. A larger one is cut off here; the counts say so.
const MAX_PATHS = 10_000;

const PROJECT_URL = /\bhttps:\/\/([a-z0-9]{20})\.supabase\.co(?![a-z0-9.-])/g;
// The same shape as the service_role rule in secrets.ts.
const JWT = /\beyJ[A-Za-z0-9_-]{8,}\.eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{16,}/g;

// The Supabase project URLs and anon keys found in one site's client code. Held in memory for the
// length of one scan; `refs()` and `pairs()` never leave `scanClientCode`.
export class SupabaseClientCollector {
  private readonly urls = new Set<string>();
  private readonly keys = new Map<string, string>();

  add(text: string): void {
    for (const m of text.matchAll(PROJECT_URL)) this.urls.add(m[1]!);
    for (const m of text.matchAll(JWT)) {
      const token = m[0];
      if (looksLikePlaceholder(token)) continue;
      const p = jwtPayload(token);
      if (p?.role !== "anon" || typeof p.ref !== "string" || !SUPABASE_REF.test(p.ref)) continue;
      if (!this.keys.has(p.ref)) this.keys.set(p.ref, token);
    }
  }

  // The refs the site names by URL. The scope rule for the Supabase host reads this set.
  refs(): ReadonlySet<string> {
    return this.urls;
  }

  // Projects the site names by URL AND for which it ships an anon key whose `ref` claim is that
  // project. A key without a matching URL, or a URL without a key, is never probed.
  pairs(): { ref: string; anonKey: string }[] {
    return [...this.urls].filter((r) => this.keys.has(r)).sort().map((ref) => ({ ref, anonKey: this.keys.get(ref)! }));
  }
}

export interface ExposedNames {
  relations: string[];
  relationCount: number;
  functions: string[];
  functionCount: number;
  // Names dropped by `safeName`. Counted, never stored.
  unsafeNames: number;
  // More paths than MAX_PATHS: the counts are a floor.
  capped: boolean;
}

// The exposed names in a PostgREST OpenAPI (Swagger 2.0) document, or null when the text is not one.
// `/name` is a table or view, `/rpc/name` a function; `/` is the root itself.
export function exposedNames(text: string): ExposedNames | null {
  let doc: unknown;
  try {
    doc = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof doc !== "object" || doc === null || Array.isArray(doc)) return null;
  const paths = (doc as { paths?: unknown }).paths;
  if (typeof paths !== "object" || paths === null || Array.isArray(paths)) return null;

  const relations = new Set<string>();
  const functions = new Set<string>();
  let relationCount = 0;
  let functionCount = 0;
  let unsafeNames = 0;
  let seen = 0;
  let capped = false;
  for (const key of Object.keys(paths)) {
    if (seen++ >= MAX_PATHS) {
      capped = true;
      break;
    }
    if (!key.startsWith("/") || key === "/") continue;
    const isFunction = key.startsWith("/rpc/");
    const name = safeName(isFunction ? key.slice(5) : key.slice(1));
    if (isFunction) functionCount++;
    else relationCount++;
    if (name === null) {
      unsafeNames++;
      continue;
    }
    (isFunction ? functions : relations).add(name);
  }
  const listed = (s: Set<string>) => [...s].sort().slice(0, MAX_LISTED);
  return { relations: listed(relations), relationCount, functions: listed(functions), functionCount, unsafeNames, capped };
}

export type ExposureOutcome = "exposed" | "nothing-exposed" | "denied" | "unreadable" | "too-large" | "failed" | "refused";

export interface ExposureCheck {
  ref: string;
  outcome: ExposureOutcome;
  // `http <status>`, `timeout`, ... for a failed or refused request.
  reason?: string;
}

const FIX =
  "The anon key ships in your app, so anyone can use it to reach these tables, views and functions through the " +
  "Data API. For each table your app reads with the anon key, turn on row level security and add policies that " +
  "allow only what the app needs. Revoke anon grants on everything else (REVOKE ALL ON ... FROM anon). Views run " +
  "with their owner's rights and skip RLS: set security_invoker = true, and use a security definer view only on " +
  "purpose. For functions the app does not call signed out, REVOKE EXECUTE ... FROM anon, public.";

function finding(ref: string, anonKey: string, names: ExposedNames): ScanFindingInput {
  const severity: ScanSeverity = names.relationCount > 0 ? "medium" : "low";
  return {
    severity,
    type: "anon-key-exposure:openapi",
    endpoint: `https://${ref}.supabase.co/rest/v1/`,
    evidence: {
      rule: "supabase-anon-openapi",
      name: "Data API objects the anon key can reach",
      projectRef: ref,
      fingerprint: fingerprint(anonKey),
      last4: anonKey.slice(-4),
      relationCount: names.relationCount,
      relationNames: names.relations,
      functionCount: names.functionCount,
      functionNames: names.functions,
      unsafeNames: names.unsafeNames,
      capped: names.capped,
    },
    fix: FIX,
    supahoundMonitor: "exposed_read",
  };
}

// One GET per paired project (at most MAX_PROJECTS), each to its PostgREST root and nowhere else.
export async function probeAnonExposure(
  collector: SupabaseClientCollector,
  opts: ScopedFetchOptions = {},
): Promise<{ findings: ScanFindingInput[]; checks: ExposureCheck[] }> {
  const findings: ScanFindingInput[] = [];
  const checks: ExposureCheck[] = [];
  const named = collector.refs();
  for (const { ref, anonKey } of collector.pairs().slice(0, MAX_PROJECTS)) {
    const doc = await supabaseRestRootGet(ref, anonKey, named, opts);
    if (doc.kind === "refused") {
      checks.push({ ref, outcome: "refused", reason: doc.reason });
      continue;
    }
    if (doc.kind === "failed") {
      checks.push({ ref, outcome: "failed", reason: doc.reason });
      continue;
    }
    if (doc.status === 401 || doc.status === 403) {
      checks.push({ ref, outcome: "denied", reason: `http ${doc.status}` });
      continue;
    }
    if (doc.status !== 200) {
      checks.push({ ref, outcome: "failed", reason: `http ${doc.status}` });
      continue;
    }
    if (doc.truncated) {
      checks.push({ ref, outcome: "too-large" });
      continue;
    }
    const names = exposedNames(doc.text);
    if (names === null) {
      checks.push({ ref, outcome: "unreadable" });
      continue;
    }
    if (names.relationCount === 0 && names.functionCount === 0) {
      checks.push({ ref, outcome: "nothing-exposed" });
      continue;
    }
    checks.push({ ref, outcome: "exposed" });
    findings.push(finding(ref, anonKey, names));
  }
  return { findings, checks };
}

const RANK: Record<ScanSeverity, number> = { critical: 5, high: 4, medium: 3, low: 2, info: 1 };

export interface ClientCodeExposureResult extends SecretsScanResult {
  exposure: ExposureCheck[];
}

// The secrets scan of a verified site's client code, then the anon-key exposure check on what it
// found. A separate entry point from `scanClientCode`, like `probeLeakPaths` (decision 026): the
// funnel keeps calling `scanClientCode` alone until legal review clears this check (decision 046).
// Throws only when `targetUrl` is outside the verified apex, before any request.
export async function scanClientCodeWithAnonExposure(
  targetUrl: string,
  verifiedApex: string,
  opts: ScopedFetchOptions = {},
): Promise<ClientCodeExposureResult> {
  const collector = new SupabaseClientCollector();
  const scan = await scanClientCode(targetUrl, verifiedApex, { ...opts, onText: (t) => collector.add(t) });
  const { findings, checks } = await probeAnonExposure(collector, opts);
  return {
    ...scan,
    findings: [...scan.findings, ...findings].sort((a, b) => RANK[b.severity] - RANK[a.severity]),
    exposure: checks,
  };
}
