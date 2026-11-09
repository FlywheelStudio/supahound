import { publicRoutes } from "../../content/routes";
import { FEATURES } from "../../content/features";
import { PLANS, SITE_DESCRIPTION } from "../../content/site";
import { abs } from "../../lib/seo";

// llms.txt (https://llmstxt.org): a plain map of the site for answer engines.
export const dynamic = "force-static";

export function GET() {
  const groups = new Map<string, string[]>();
  for (const r of publicRoutes()) {
    const lines = groups.get(r.group) ?? [];
    lines.push(`- [${r.title}](${abs(r.path)}): ${r.summary}`);
    groups.set(r.group, lines);
  }
  const plans = PLANS.map((p) => `- ${p.name}: ${p.priceLabel} ${p.unit}. ${p.features.map((f) => (f.feature && FEATURES[f.feature].status === "soon" ? `${f.text} (coming soon)` : f.text)).join("; ")}.`).join("\n");
  const body = [
    "# Supahound",
    "",
    `> ${SITE_DESCRIPTION}`,
    "",
    "Supahound is in early access: features marked (coming soon) are not live yet.",
    "",
    "Supahound is made by Flywheel Studio LLC (https://flywheel.so). It connects to a Supabase org with read-only OAuth (analytics:read, database:read), never asks for a service-role key, and stores no raw log rows.",
    "",
    "## Plans",
    "",
    plans,
    "",
    ...[...groups].flatMap(([g, lines]) => [`## ${g}`, "", ...lines, ""]),
  ].join("\n");
  return new Response(body, { headers: { "content-type": "text/plain; charset=utf-8", "cache-control": "public, max-age=3600" } });
}
