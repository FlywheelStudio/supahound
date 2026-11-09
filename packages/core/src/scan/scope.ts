// Scope control for the scan funnel (hackme.si).
//
// Two independent gates stand between a user and an active scan: proof that they control the
// domain (see verify.ts) and this scope guard. The guard answers one question the engine asks
// before every target it touches: "is this host inside the one verified apex, and is the apex one
// we are allowed to scan at all?" Scope is enforced here, in code, not just in the clickwrap prose
// (PRD, Legal & authorization gating).

import { parse } from "tldts";

export class ScopeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ScopeError";
  }
}

// Major platforms and infrastructure a founder's own app is never hosted *as*. Verifying a TXT
// record on one of these should still not let the engine point at it. This is defence in depth
// behind DNS verification, not the primary gate, and it is meant to be extended from config.
const PLATFORM_DENYLIST = new Set<string>([
  "google.com", "gmail.com", "youtube.com", "facebook.com", "instagram.com", "whatsapp.com",
  "apple.com", "icloud.com", "microsoft.com", "live.com", "office.com", "azure.com",
  "amazon.com", "aws.amazon.com", "amazonaws.com", "cloudflare.com", "vercel.com", "vercel.app",
  "netlify.app", "github.com", "gitlab.com", "openai.com", "anthropic.com", "x.com", "twitter.com",
  "linkedin.com", "stripe.com", "paypal.com", "supabase.com", "supabase.co", "supabase.io",
]);

// Public-suffix labels that mark a government or military domain anywhere in the world. Checked
// against every label of the apex's public suffix, so `gov.uk`, `mil.kr`, `gouv.fr`, `go.jp` and
// a bare `.gov`/`.mil` all match.
const PUBLIC_SECTOR_LABELS = new Set<string>(["gov", "mil", "gouv", "go", "gob", "govt"]);

// The registrable apex (eTLD+1) of a URL or bare hostname, lowercased, or null when there is no
// scannable domain: an IP address, a bare public suffix, localhost, or unparseable input. We bind
// scope to the apex, never to a raw URL, so a verified apex authorizes exactly its own tree.
export function registrableApex(input: string): string | null {
  const trimmed = input.trim();
  if (trimmed === "") return null;
  // tldts reads a full URL or a bare hostname. Give it a scheme when none is present so an input
  // like "example.com/path" is read as a host, not a path.
  const withScheme = /^[a-z][a-z0-9+.-]*:\/\//i.test(trimmed) ? trimmed : `https://${trimmed}`;
  const result = parse(withScheme);
  if (result.isIp) return null;
  return result.domain ? result.domain.toLowerCase() : null;
}

// True when the apex belongs to a class we refuse regardless of a (possibly spoofed) TXT record.
export function isDeniedApex(apex: string): boolean {
  const normalized = apex.toLowerCase();
  if (PLATFORM_DENYLIST.has(normalized)) return true;
  const suffix = parse(`https://${normalized}`).publicSuffix;
  if (!suffix) return true; // No known public suffix: not a real registrable domain.
  return suffix.split(".").some((label) => PUBLIC_SECTOR_LABELS.has(label));
}

// Normalizes and authorizes an apex for scanning, or throws. The only way the rest of the funnel
// should turn user input into a scannable apex.
export function assertScannableApex(input: string): string {
  const apex = registrableApex(input);
  if (apex === null) throw new ScopeError("Enter a real domain, not an IP address or a bare suffix");
  if (isDeniedApex(apex)) throw new ScopeError(`${apex} is a protected domain and cannot be scanned`);
  return apex;
}

// Whether a target host sits inside the verified apex's tree. Used by the engine on every target.
// The host must be the apex itself or a subdomain of it, and resolve to the same registrable apex,
// so a look-alike such as "verifiedapex.com.evil.test" is refused.
export function hostInScope(host: string, verifiedApex: string): boolean {
  const h = host.trim().toLowerCase().replace(/\.$/, "");
  const apex = verifiedApex.toLowerCase();
  if (h !== apex && !h.endsWith(`.${apex}`)) return false;
  return registrableApex(h) === apex;
}

// Throws unless the target is in scope. The engine calls this; it never scans on a false return it
// forgot to check.
export function assertInScope(host: string, verifiedApex: string): void {
  if (!hostInScope(host, verifiedApex)) {
    throw new ScopeError(`${host} is outside the verified scope of ${verifiedApex}`);
  }
}
