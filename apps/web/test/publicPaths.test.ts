import { describe, expect, it } from "vitest";
import { isPublicMarketingPath } from "../lib/security";

describe("isPublicMarketingPath", () => {
  it.each(["/", "/pricing", "/hack-me", "/platforms", "/platforms/lovable", "/guides/postgres/rls-basics",
    "/compare/aikido", "/privacy", "/terms", "/sitemap.xml", "/robots.txt", "/llms.txt"])(
    "treats %s as public", (p) => expect(isPublicMarketingPath(p)).toBe(true));

  // Every signed-in or session-reading route must keep the session refresh.
  it.each(["/app", "/app/x", "/w/123", "/onboarding", "/auth/confirm", "/auth/signout", "/api/supabase/callback",
    "/api/auth/send-email-hook", "/login", "/pricingx", "/platformsevil", "/guides-admin", "//pricing", ""])(
    "keeps the session refresh on %s", (p) => expect(isPublicMarketingPath(p)).toBe(false));
});
