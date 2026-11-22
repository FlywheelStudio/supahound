import { ENTERPRISE_HISTORY_DAYS, type HistoryWindow } from "@supahound/core/billing/history";

// How the history pages and the plan pages name a workspace's history window (decision 048).

// "30 days", "90 days", or "year" for the Enterprise window, so pages read "the last 30 days" and
// "the last year".
export function windowPhrase(days: number): string {
  return days === ENTERPRISE_HISTORY_DAYS ? "year" : `${days} days`;
}

// The plan pages' one line about history.
export function historyLine(window: HistoryWindow): string {
  return window.plan === "enterprise"
    ? "1-year history: incidents, findings and the security log."
    : `${window.incidentDays}-day incident history and a ${window.securityEventDays}-day security log. Enterprise keeps a year.`;
}

// The Enterprise card in the workspace billing page's price list.
export const ENTERPRISE_DETAIL =
  "Above 10 million requests per project. 1-year history of incidents, findings and security events. The project stays on Pro until we agree terms.";
