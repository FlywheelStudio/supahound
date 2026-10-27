import { allowedFacts, type IncidentFeatures } from "./features.js";

export interface Explanation {
  summary: string;
  likelyImpact: string;
  nextSteps: string[];
}

// PRD, Output validation: every number and entity in the model's text must match the evidence.
// Also bans what must never reach an alert: links, markup, and anything shaped like an ID, an
// email or an IP address (the model never saw one, so any it writes is invented).
export function validateExplanation(e: Explanation, features: IncidentFeatures): string[] {
  const { numbers, identifiers } = allowedFacts(features);
  const problems: string[] = [];
  const texts = [e.summary, e.likelyImpact, ...e.nextSteps];

  for (const text of texts) {
    if (/https?:\/\/|www\.|\]\(|[<>]/i.test(text)) problems.push("link_or_markup");
    if (/[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}/i.test(text)) problems.push("uuid");
    if (/[^\s@]+@[^\s@]+\.[a-z]{2,}/i.test(text)) problems.push("email");
    if (/\b\d{1,3}(\.\d{1,3}){3}\b/.test(text)) problems.push("ip_address");

    for (const m of text.matchAll(/`([^`]+)`/g)) {
      if (!identifiers.has(m[1]!)) problems.push(`unknown_identifier:${m[1]}`);
    }
    // Strip backticked identifiers (they may contain digits) before checking numbers.
    for (const m of text.replace(/`[^`]*`/g, "").matchAll(/\d+(?:[.,]\d+)*/g)) {
      const n = Number(m[0].replace(/,/g, ""));
      if (!numbers.has(n)) problems.push(`unknown_number:${m[0]}`);
    }
  }
  return [...new Set(problems)];
}
