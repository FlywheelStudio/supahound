import type { MetadataRoute } from "next";
import { publicRoutes } from "../content/routes";
import { abs } from "../lib/seo";

export default function sitemap(): MetadataRoute.Sitemap {
  return publicRoutes().map((r) => ({ url: abs(r.path), lastModified: r.updated, priority: r.priority }));
}
