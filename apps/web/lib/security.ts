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

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}
