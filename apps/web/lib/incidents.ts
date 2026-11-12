import { cleanText } from "@supahound/core/alerts/email";
import type { IncidentCursor } from "@supahound/core/db/repo";

// Incident history (issue #44, decision 035). Pure helpers for the list and detail pages: the
// URL cursor, the incident ID, and the stored explanation. Every input here comes from a URL or a
// jsonb column, so nothing reaches Postgres or the page unchecked.

export const HISTORY_PAGE_SIZE = 25;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Epoch microseconds: up to 17 digits covers every date before the year 5000.
const MICROS = /^[1-9][0-9]{0,16}$/;

// A path segment that is not a UUID is a 404, before any query (a ::uuid cast would throw a 500).
export function parseIncidentId(raw: string): string | null {
  return UUID.test(raw) ? raw.toLowerCase() : null;
}

// The cursor in the URL: "<epoch microseconds>_<incident id>".
export function encodeCursor(c: IncidentCursor): string {
  return `${c.lastSeenUs}_${c.id}`;
}

// A missing cursor is the first page (null). A malformed one is "invalid": the page answers 404,
// so a mangled link never shows a different page than the one it names.
export function parseCursor(raw: string | string[] | undefined): IncidentCursor | null | "invalid" {
  if (raw === undefined) return null;
  if (typeof raw !== "string") return "invalid";
  const [us, id, ...rest] = raw.split("_");
  if (rest.length > 0 || !us || !id || !MICROS.test(us) || !UUID.test(id)) return "invalid";
  return { lastSeenUs: us, id: id.toLowerCase() };
}

export interface Explanation {
  summary: string;
  likelyImpact: string;
  nextSteps: string[];
}

const MAX_SUMMARY = 600;
const MAX_IMPACT = 400;
const MAX_STEP = 200;
const MAX_STEPS = 5;

// The explainer stores { summary, likelyImpact, nextSteps } (model or template, both validated).
// The column is jsonb, so check the shape, then clean every string as the alert email does:
// links stripped, control characters removed, length capped. Anything else is null.
export function explanationOf(stored: unknown): Explanation | null {
  if (!stored || typeof stored !== "object" || Array.isArray(stored)) return null;
  const s = stored as Record<string, unknown>;
  if (typeof s.summary !== "string") return null;
  const summary = cleanText(s.summary, MAX_SUMMARY);
  if (!summary) return null;
  const likelyImpact = typeof s.likelyImpact === "string" ? cleanText(s.likelyImpact, MAX_IMPACT) : "";
  const nextSteps = Array.isArray(s.nextSteps)
    ? s.nextSteps.filter((x): x is string => typeof x === "string").slice(0, MAX_STEPS).map((x) => cleanText(x, MAX_STEP)).filter((x) => x.length > 0)
    : [];
  return { summary, likelyImpact, nextSteps };
}

// Splits text on `backticks`: identifiers (tables, columns, auth.uid()) render as <code>.
export function codeSegments(text: string): { text: string; code: boolean }[] {
  const out: { text: string; code: boolean }[] = [];
  const re = /`([^`]{1,80})`/g;
  let at = 0;
  for (const m of text.matchAll(re)) {
    if (m.index > at) out.push({ text: text.slice(at, m.index), code: false });
    out.push({ text: m[1]!, code: true });
    at = m.index + m[0].length;
  }
  if (at < text.length) out.push({ text: text.slice(at), code: false });
  return out;
}

// "12 minutes", "1 minute", "under a minute", "3 h 5 min".
export function durationLabel(from: Date, to: Date): string {
  const minutes = Math.max(0, Math.round((to.getTime() - from.getTime()) / 60_000));
  if (minutes === 0) return "under a minute";
  if (minutes < 60) return `${minutes} minute${minutes === 1 ? "" : "s"}`;
  const h = Math.floor(minutes / 60);
  const m = minutes % 60;
  return m === 0 ? `${h} h` : `${h} h ${m} min`;
}

// A summary built from structured fields only, for an incident the explainer never described
// (it explains only incidents that page or email).
export function fallbackSummary(i: { hits: number; findingCount: number }): string {
  const n = (x: number, one: string) => `${x.toLocaleString("en-US")} ${one}${x === 1 ? "" : "s"}`;
  return `${n(i.hits, "request")} in ${n(i.findingCount, "finding")}. No written summary: Supahound writes one only for incidents that alert.`;
}
