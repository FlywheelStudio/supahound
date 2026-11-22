// How far back a workspace sees and keeps its history (issue #170, decision 048).
//
// Two plans of history, one per workspace:
//   * standard: incident history and findings 30 days (decision 035), security events 90 days
//     (decision 044).
//   * enterprise: one year of each. A workspace has it while an operator has marked it Enterprise
//     (billing_accounts.enterprise_at, set by hand when terms are agreed) or while it has a staff
//     exemption (decision 029).
//
// The window does two things, and nothing else:
//   1. The history pages (incident list and detail, security log) show only rows inside it.
//   2. The daily data job, for a workspace that does NOT pay, deletes rows older than it. While a
//      workspace pays, decision 037 still deletes nothing, whatever the window.
// So a downgrade (enterprise_at cleared) hides the older rows at once; they are deleted only once
// the workspace no longer pays, by the next daily job, like every other workspace's history.
//
// Nothing is stored per row: the window is read from the plan on every query.

export const STANDARD_INCIDENT_DAYS = 30;
export const STANDARD_SECURITY_EVENT_DAYS = 90;
export const ENTERPRISE_HISTORY_DAYS = 365;

export type HistoryPlan = "standard" | "enterprise";

export interface HistoryWindow {
  plan: HistoryPlan;
  // Incidents (by last_seen_at; an open incident always shows), findings and poll runs.
  incidentDays: number;
  // Security events (by created_at).
  securityEventDays: number;
}

export const STANDARD_HISTORY: HistoryWindow = Object.freeze({
  plan: "standard",
  incidentDays: STANDARD_INCIDENT_DAYS,
  securityEventDays: STANDARD_SECURITY_EVENT_DAYS,
});

export const ENTERPRISE_HISTORY: HistoryWindow = Object.freeze({
  plan: "enterprise",
  incidentDays: ENTERPRISE_HISTORY_DAYS,
  securityEventDays: ENTERPRISE_HISTORY_DAYS,
});

export interface HistoryPlanInput {
  // billing_accounts.enterprise_at: when an operator marked the workspace Enterprise; null otherwise.
  enterpriseAt: Date | null;
  // Decision 029, computed on every read (the sole owner is still the exempt one).
  exempt: boolean;
}

export function historyWindowFor(account: HistoryPlanInput): HistoryWindow {
  return account.enterpriseAt !== null || account.exempt ? ENTERPRISE_HISTORY : STANDARD_HISTORY;
}

// A whole number of days, from 1 to 3660, so a window never reaches SQL as anything but a small int.
export function checkWindowDays(days: number): number {
  if (!Number.isInteger(days) || days < 1 || days > 3660) throw new Error(`history window out of range: ${days}`);
  return days;
}
