// Domain-ownership verification for the scan funnel (hackme.si).
//
// Proof of control is the hard gate: no active scan runs until the user's DNS carries a token we
// issued (PRD, Domain ownership verification). We read the TXT record over DoH from several
// resolvers and require them to agree, so a stale cache or a split-horizon answer on one resolver
// cannot pass a domain. Everything here is a read of public DNS; nothing touches the target.

import { randomBytes, timingSafeEqual } from "node:crypto";

// The TXT value the user adds. We accept it either on the apex or on the `_hackme-verify` label.
export const RECORD_PREFIX = "hackme-verify";
export const SUBDOMAIN_LABEL = "_hackme-verify";

export interface Challenge {
  token: string;
  // The exact TXT value the user must publish.
  value: string;
  // The two record names we will accept it on.
  names: string[];
}

// A fresh single-use challenge for an apex. The token is 128 bits of hex; the record value carries
// the prefix so an unrelated TXT record can never collide with it.
export function newChallenge(apex: string): Challenge {
  const token = randomBytes(16).toString("hex");
  return {
    token,
    value: `${RECORD_PREFIX}=${token}`,
    names: [apex, `${SUBDOMAIN_LABEL}.${apex}`],
  };
}

// Equal-length, constant-time string compare. Length is not secret; the token is.
function matches(a: string, b: string): boolean {
  const ab = Buffer.from(a, "utf8");
  const bb = Buffer.from(b, "utf8");
  return ab.length === bb.length && timingSafeEqual(ab, bb);
}

export interface Resolver {
  name: string;
  // Builds the DoH JSON query URL for a record name.
  url: (dnsName: string) => string;
}

// Two independent DoH providers, both returning Google's dns-json shape.
export const DEFAULT_RESOLVERS: Resolver[] = [
  { name: "cloudflare", url: (n) => `https://cloudflare-dns.com/dns-query?type=TXT&name=${encodeURIComponent(n)}` },
  { name: "google", url: (n) => `https://dns.google/resolve?type=TXT&name=${encodeURIComponent(n)}` },
];

type FetchLike = (url: string, init?: { headers?: Record<string, string> }) => Promise<{
  ok: boolean;
  status: number;
  json: () => Promise<unknown>;
}>;

interface DohAnswer {
  type?: number;
  data?: string;
}

// TXT values from one DoH answer set. A TXT record arrives as one or more quoted chunks that the
// client concatenates; we unquote and join them, and keep only TXT (type 16) answers.
function txtValues(payload: unknown): string[] {
  const answers = (payload as { Answer?: DohAnswer[] } | null)?.Answer;
  if (!Array.isArray(answers)) return [];
  const out: string[] = [];
  for (const a of answers) {
    if (a.type !== 16 || typeof a.data !== "string") continue;
    const chunks = a.data.match(/"([^"]*)"/g);
    out.push(chunks ? chunks.map((c) => c.slice(1, -1)).join("") : a.data);
  }
  return out;
}

export interface ResolverResult {
  resolver: string;
  found: boolean;
  // Non-sensitive: how many TXT records answered and whether the query errored. Part of the audit
  // trail; never the token itself.
  records: number;
  error?: string;
}

export interface VerificationResult {
  verified: boolean;
  checkedAt: string;
  // How many resolvers had to agree, and how many did.
  required: number;
  agreed: number;
  resolvers: ResolverResult[];
}

export interface VerifyOptions {
  resolvers?: Resolver[];
  fetchImpl?: FetchLike;
  now?: () => Date;
}

async function askResolver(resolver: Resolver, names: string[], value: string, fetchImpl: FetchLike): Promise<ResolverResult> {
  let records = 0;
  try {
    for (const name of names) {
      const res = await fetchImpl(resolver.url(name), { headers: { accept: "application/dns-json" } });
      if (!res.ok) return { resolver: resolver.name, found: false, records, error: `http ${res.status}` };
      const values = txtValues(await res.json());
      records += values.length;
      if (values.some((v) => matches(v, value))) return { resolver: resolver.name, found: true, records };
    }
    return { resolver: resolver.name, found: false, records };
  } catch (err) {
    return { resolver: resolver.name, found: false, records, error: err instanceof Error ? err.message : "lookup failed" };
  }
}

// Checks the apex against every resolver and returns the audit trail. verified is true only when a
// quorum of resolvers each saw the exact challenge value: a strict majority, and never fewer than
// two. A resolver that errors counts as disagreement, not as a pass.
export async function verifyChallenge(challenge: Challenge, apex: string, opts: VerifyOptions = {}): Promise<VerificationResult> {
  const resolvers = opts.resolvers ?? DEFAULT_RESOLVERS;
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);
  const now = opts.now ?? (() => new Date());
  const names = [apex, `${SUBDOMAIN_LABEL}.${apex}`];

  const results = await Promise.all(resolvers.map((r) => askResolver(r, names, challenge.value, fetchImpl)));
  const agreed = results.filter((r) => r.found).length;
  const required = Math.max(2, Math.ceil(resolvers.length / 2));
  return { verified: agreed >= required, checkedAt: now().toISOString(), required, agreed, resolvers: results };
}
