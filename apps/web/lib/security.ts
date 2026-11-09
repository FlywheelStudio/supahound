// Request-level checks shared by middleware and route handlers.

// State-changing requests must come from the app's own origin. Server-to-server callers that
// sign their requests (the Supabase Send Email Hook) are listed and checked by signature instead.
export const SIGNED_ROUTES = ["/api/auth/send-email-hook"] as const;

export function isSafeMethod(method: string): boolean {
  return method === "GET" || method === "HEAD" || method === "OPTIONS";
}

export function isSameOrigin(request: Request, appUrl: string): boolean {
  const origin = request.headers.get("origin");
  if (!origin) return false;
  try {
    return new URL(origin).origin === new URL(appUrl).origin;
  } catch {
    return false;
  }
}

// Post-login redirects stay inside the app: a relative path, never `//host` or a URL.
export function safeNext(next: string | null | undefined, fallback = "/app"): string {
  if (!next || !next.startsWith("/") || next.startsWith("//") || next.startsWith("/\\")) return fallback;
  return next;
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Marketing pages render the same for everyone. They never read the session, so the middleware
// skips the Supabase refresh for them: no auth round trip and no Set-Cookie on a cacheable page.
// This is an allowlist on purpose. Any path not listed here keeps the session refresh.
const PUBLIC_EXACT = ["/", "/sitemap.xml", "/robots.txt", "/llms.txt", "/og.png", "/favicon.svg"] as const;
const PUBLIC_SECTIONS = ["/pricing", "/hack-me", "/platforms", "/guides", "/compare", "/privacy", "/terms"] as const;

export function isPublicMarketingPath(path: string): boolean {
  if ((PUBLIC_EXACT as readonly string[]).includes(path)) return true;
  return PUBLIC_SECTIONS.some((s) => path === s || path.startsWith(`${s}/`));
}
