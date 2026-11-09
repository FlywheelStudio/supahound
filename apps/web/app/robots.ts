import type { MetadataRoute } from "next";
import { abs } from "../lib/seo";

// Search and answer engines may read every public page; nobody should index signed-in routes.
const PRIVATE = ["/app", "/w/", "/onboarding", "/auth/", "/api/", "/login"];
const AI_CRAWLERS = ["GPTBot", "OAI-SearchBot", "ChatGPT-User", "ClaudeBot", "Claude-User", "Claude-SearchBot", "PerplexityBot", "Google-Extended", "Applebot-Extended"];

export default function robots(): MetadataRoute.Robots {
  return {
    rules: [
      { userAgent: "*", allow: "/", disallow: PRIVATE },
      { userAgent: AI_CRAWLERS, allow: "/", disallow: PRIVATE },
    ],
    sitemap: abs("/sitemap.xml"),
    host: abs("/"),
  };
}
