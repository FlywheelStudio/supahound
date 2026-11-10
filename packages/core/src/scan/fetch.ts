// The scan funnel's only way to read from a target (hackme.si, decisions 016 and 026).
//
// Every request goes through `scopedGet`. It refuses any URL outside the verified apex, follows
// redirects by hand so each hop passes the scope guard too, and caps bytes and time. The passive
// checks build on it; nothing in `scan/` calls `fetch` directly.

import { assertInScope, ScopeError } from "./scope.js";

export const SCANNER_USER_AGENT = "Supahound-hackme/1.0 (+https://hackme.si; authorized scan)";

export interface ScanLimits {
  // Bytes read from one response body. The rest is not downloaded.
  maxBytes: number;
  // Scripts and source maps fetched for one page, after the page itself.
  maxScripts: number;
  // Redirect hops followed for one request.
  maxRedirects: number;
  // Time allowed for one request, including its redirects.
  timeoutMs: number;
}

export const DEFAULT_LIMITS: ScanLimits = {
  maxBytes: 5_000_000,
  maxScripts: 40,
  maxRedirects: 3,
  timeoutMs: 10_000,
};

export interface FetchLikeResponse {
  status: number;
  headers: { get(name: string): string | null };
  body?: ReadableStream<Uint8Array> | null;
  text(): Promise<string>;
}

export type FetchLike = (
  url: string,
  init: { method: "GET"; redirect: "manual"; headers: Record<string, string>; signal?: AbortSignal },
) => Promise<FetchLikeResponse>;

export interface ScopedFetchOptions {
  fetchImpl?: FetchLike;
  limits?: Partial<ScanLimits>;
}

export interface FetchedDocument {
  kind: "ok";
  url: string; // The final URL after redirects.
  status: number;
  contentType: string;
  text: string;
  truncated: boolean;
}

export interface RefusedFetch {
  kind: "refused";
  url: string;
  reason: "out-of-scope" | "bad-url" | "too-many-redirects";
}

export interface FailedFetch {
  kind: "failed";
  url: string;
  reason: string;
}

export type FetchOutcome = FetchedDocument | RefusedFetch | FailedFetch;

export function resolveLimits(limits?: Partial<ScanLimits>): ScanLimits {
  return { ...DEFAULT_LIMITS, ...limits };
}

// A URL for reports and evidence: no query string, no fragment, no credentials. A script URL can
// carry a token in its query; evidence never repeats it.
export function reportUrl(url: string): string {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}${u.pathname}`.slice(0, 2048);
  } catch {
    return "";
  }
}

// Parses a URL the scanner may request: http(s), no credentials, default port, host inside the
// verified apex. Returns null when the URL is not one we request; throws nothing.
export function scannableUrl(raw: string, verifiedApex: string, base?: string): URL | "out-of-scope" | null {
  let u: URL;
  try {
    u = base === undefined ? new URL(raw) : new URL(raw, base);
  } catch {
    return null;
  }
  if (u.protocol !== "https:" && u.protocol !== "http:") return null;
  if (u.username !== "" || u.password !== "") return null;
  if (u.port !== "") return null; // Another port is another service; scope is the web origin only.
  try {
    assertInScope(u.hostname, verifiedApex);
  } catch (err) {
    if (err instanceof ScopeError) return "out-of-scope";
    throw err;
  }
  u.hash = "";
  return u;
}

async function readCapped(res: FetchLikeResponse, maxBytes: number): Promise<{ text: string; truncated: boolean }> {
  const body = res.body;
  if (!body || typeof body.getReader !== "function") {
    const text = await res.text();
    return text.length > maxBytes ? { text: text.slice(0, maxBytes), truncated: true } : { text, truncated: false };
  }
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let read = 0;
  let text = "";
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    const room = maxBytes - read;
    if (value.byteLength > room) {
      text += decoder.decode(value.subarray(0, room));
      await reader.cancel().catch(() => undefined);
      return { text, truncated: true };
    }
    read += value.byteLength;
    text += decoder.decode(value, { stream: true });
  }
  return { text: text + decoder.decode(), truncated: false };
}

// GET one URL inside the verified apex. Each redirect hop passes the scope guard before it is
// requested; a hop outside scope ends the request as refused, never followed.
export async function scopedGet(rawUrl: string, verifiedApex: string, opts: ScopedFetchOptions = {}): Promise<FetchOutcome> {
  const limits = resolveLimits(opts.limits);
  const fetchImpl = opts.fetchImpl ?? (globalThis.fetch as unknown as FetchLike);

  const first = scannableUrl(rawUrl, verifiedApex);
  if (first === null) return { kind: "refused", url: reportUrl(rawUrl), reason: "bad-url" };
  if (first === "out-of-scope") return { kind: "refused", url: reportUrl(rawUrl), reason: "out-of-scope" };

  const signal = AbortSignal.timeout(limits.timeoutMs);
  let current = first;
  for (let hop = 0; ; hop++) {
    let res: FetchLikeResponse;
    try {
      res = await fetchImpl(current.toString(), {
        method: "GET",
        redirect: "manual",
        headers: { "user-agent": SCANNER_USER_AGENT, accept: "*/*" },
        signal,
      });
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "network error";
      return { kind: "failed", url: reportUrl(current.toString()), reason };
    }

    if (res.status >= 300 && res.status < 400) {
      const location = res.headers.get("location");
      if (location === null) return { kind: "failed", url: reportUrl(current.toString()), reason: `http ${res.status} without location` };
      if (hop >= limits.maxRedirects) return { kind: "refused", url: reportUrl(current.toString()), reason: "too-many-redirects" };
      const next = scannableUrl(location, verifiedApex, current.toString());
      if (next === null) return { kind: "refused", url: reportUrl(current.toString()), reason: "bad-url" };
      if (next === "out-of-scope") return { kind: "refused", url: reportUrl(current.toString()), reason: "out-of-scope" };
      await res.body?.cancel().catch(() => undefined);
      current = next;
      continue;
    }

    try {
      const { text, truncated } = await readCapped(res, limits.maxBytes);
      return {
        kind: "ok",
        url: current.toString(),
        status: res.status,
        contentType: (res.headers.get("content-type") ?? "").toLowerCase(),
        text,
        truncated,
      };
    } catch (err) {
      const reason = err instanceof Error && err.name === "TimeoutError" ? "timeout" : "read error";
      return { kind: "failed", url: reportUrl(current.toString()), reason };
    }
  }
}
