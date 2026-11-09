// Platform landing pages (/platforms/<slug>) and platform guides (/guides/<slug>).
// Facts come from the platform research (sources sit on each entry and render on each page).
import type { Platform } from "./types";
import { groupA } from "./platforms/groupA";
import { groupB } from "./platforms/groupB";

const ORDER = ["lovable", "bolt", "v0", "cursor", "claude-code", "replit", "windsurf", "github-copilot", "base44",
  "softgen", "rork", "same", "anything", "emergent", "tempo", "firebase-studio", "supabase"];

export const platforms: Platform[] = [...groupA, ...groupB].sort((a, b) => ORDER.indexOf(a.slug) - ORDER.indexOf(b.slug));

// The builders only (Supabase itself has a landing page but is not a builder).
export const builders = () => platforms.filter((p) => p.slug !== "supabase");

export const platform = (slug: string) => platforms.find((p) => p.slug === slug);
