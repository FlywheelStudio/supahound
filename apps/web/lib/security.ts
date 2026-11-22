// Request-level checks shared by middleware and route handlers.

// State-changing requests must come from the app's own origin. Server-to-server callers that
// sign their requests (the Supabase Send Email Hook) are listed and checked by signature instead.
// Server-to-server POSTs that check their own signature: Supabase Auth's hook and Stripe's webhook.
export const SIGNED_ROUTES = ["/api/auth/send-email-hook", "/api/stripe/webhook"] as const;

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

// Where to go after a magic-link sign-in. The login form stores it here (httpOnly, 1 hour) and
// /auth/confirm reads and clears it, so an invite link survives the round trip through email.
export const NEXT_COOKIE = "supahound_next";
export const NEXT_COOKIE_MAX_AGE = 3600;

// A fresh CSP nonce for each response: 128 random bits, base64.
export function newNonce(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(16));
  return btoa(String.fromCharCode(...bytes));
}

// The Content-Security-Policy for every page. vinext (like Next.js) reads the nonce from this
// header when the middleware sets it on the response, and puts it on the hydration scripts it
// inlines (RSC payload, bootstrap module, modulepreloads). So inline scripts need the nonce, and
// script files come only from this origin. Notes on what is left out:
// - No 'strict-dynamic': route chunks load by import() from 'self', which 'self' already allows.
// - style-src allows 'unsafe-inline': React and Tailwind may set style attributes, which a nonce
//   cannot cover; inline styles cannot run code.
// - No form-action: server actions redirect to Stripe Checkout/Portal and Supabase OAuth, and
//   Chrome applies form-action to the redirect after a form POST.
// - No upgrade-insecure-requests: local and E2E run on http://localhost. HSTS covers production.
// `dev` (vite dev only) adds 'unsafe-eval': React's development build evals for owner stacks.
export function contentSecurityPolicy(nonce: string, dev = false): string {
  return [
    "default-src 'self'",
    `script-src 'self' 'nonce-${nonce}'${dev ? " 'unsafe-eval'" : ""}`,
    "style-src 'self' 'unsafe-inline'",
    "img-src 'self' data:",
    "font-src 'self'",
    "connect-src 'self'",
    "object-src 'none'",
    "base-uri 'none'",
    "frame-ancestors 'none'",
  ].join("; ");
}

// Security headers for every response from the Worker (OWASP Secure Headers, ASVS V3). Browsers
// ignore HSTS on plain http, so it is safe to send in local dev and E2E.
export function securityHeaders(nonce: string, dev = false): Record<string, string> {
  return {
    "Content-Security-Policy": contentSecurityPolicy(nonce, dev),
    "Strict-Transport-Security": "max-age=31536000; includeSubDomains",
    "X-Content-Type-Options": "nosniff",
    "X-Frame-Options": "DENY",
    "Referrer-Policy": "strict-origin-when-cross-origin",
    "Permissions-Policy": "camera=(), microphone=(), geolocation=(), payment=(), usb=(), browsing-topics=()",
  };
}

export function setSecurityHeaders(headers: Headers, nonce: string, dev = false): void {
  for (const [name, value] of Object.entries(securityHeaders(nonce, dev))) headers.set(name, value);
}

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
