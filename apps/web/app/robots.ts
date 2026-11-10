import type { MetadataRoute } from "next";

// The app holds only sign-in and signed-in pages. Nothing here belongs in a search index; the
// marketing site has its own robots.txt (decision 025).
export default function robots(): MetadataRoute.Robots {
  return { rules: [{ userAgent: "*", disallow: "/" }] };
}
