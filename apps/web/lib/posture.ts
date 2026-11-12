import type { PostureScanRecord, PostureSummary, ScanRequest } from "@supahound/core/db/posture";
import type { ProjectRole } from "@supahound/core/db/people";
import type { SeverityCounts } from "@supahound/core/posture/findings";
import type { SourceStatus } from "@supahound/core/posture/types";
import type { ProjectId, TenantId } from "@supahound/core/tenancy/scope";
import { projectPath, utc } from "./nav";
import { can } from "./people";

// The posture scan in the web app (issue #11, decision 038) as pure functions, so every branch is
// testable. A scan Supahound could not run never reads as "no findings".

// "Scan now" is refused within this many seconds of the last attempt.
export const SCAN_COOLDOWN_SECONDS = 60;

// Owners, admins and editors start a scan, as they change project settings (decision 036).
export const canScan = (role: ProjectRole | null): boolean => can(role, "edit_settings");

export type ScanNotice = ScanRequest | "role";

export const SCAN_NOTICES: Record<ScanNotice, { tone: "ok" | "error"; text: string }> = {
  queued: { tone: "ok", text: "Scan queued. It runs on the next poll, within 2 minutes." },
  already_queued: { tone: "ok", text: "A scan is already queued. It runs on the next poll." },
  too_soon: { tone: "error", text: "A scan ran less than a minute ago. Try again in a minute." },
  role: { tone: "error", text: "Only the project's owners, admins and editors can start a scan." },
};

export function posturePath(tenant: TenantId, project: ProjectId, notice?: ScanNotice): string {
  return `${projectPath(tenant, project, "posture")}${notice ? `?scan=${notice}` : ""}`;
}

export function scanNoticeFrom(query: Record<string, string | undefined>): { tone: "ok" | "error"; text: string } | null {
  const n = query.scan;
  return n && Object.hasOwn(SCAN_NOTICES, n) ? SCAN_NOTICES[n as ScanNotice] : null;
}

export interface ScanNowDeps {
  // Inside the project transaction: whether the role may scan and, only then, the request outcome.
  request: () => Promise<{ allowed: boolean; outcome: ScanRequest | null }>;
}

export async function handleScanNow(tenant: TenantId, project: ProjectId, deps: ScanNowDeps): Promise<string> {
  const { allowed, outcome } = await deps.request();
  if (!allowed || outcome === null) return posturePath(tenant, project, "role");
  return posturePath(tenant, project, outcome);
}

const REASON: Record<Exclude<SourceStatus, "ok">, string> = {
  unauthorized: "Supabase refused access",
  rate_limited: "Supabase rate-limited the request",
  query_failed: "Supabase returned an error",
  invalid_response: "Supabase's answer could not be read",
  network_error: "Supabase did not answer",
  unavailable: "the check is not available for this project",
};

export const reasonFor = (status: SourceStatus | null): string | null => (status && status !== "ok" ? REASON[status] : null);

export const isPending = (scan: PostureScanRecord | null): boolean =>
  scan !== null && scan.requestedAt !== null && (scan.attemptedAt === null || scan.requestedAt > scan.attemptedAt);

export type PostureState =
  | { kind: "waiting" }
  | { kind: "queued" }
  | { kind: "unable"; reason: string }
  | { kind: "scanned"; at: Date };

// The catalog read is what makes a scan: without one, there is no result to show.
export function postureState(scan: PostureScanRecord | null): PostureState {
  if (isPending(scan)) return { kind: "queued" };
  if (scan?.catalogScannedAt) return { kind: "scanned", at: scan.catalogScannedAt };
  const reason = reasonFor(scan?.catalogStatus ?? null);
  return reason ? { kind: "unable", reason } : { kind: "waiting" };
}

export function stateText(state: PostureState): string {
  switch (state.kind) {
    case "waiting":
      return "First scan pending. It runs on the next poll, within 2 minutes of picking the project.";
    case "queued":
      return "Scan queued. It runs on the next poll, within 2 minutes.";
    case "unable":
      return `Unable to assess: ${state.reason}. Supahound retries every hour.`;
    case "scanned":
      return `Last scan ${utc(state.at)}.`;
  }
}

// Notes for the sources that failed on their last attempt, shown next to the results.
export function sourceNotes(scan: PostureScanRecord | null): string[] {
  if (!scan) return [];
  const notes: string[] = [];
  const catalog = reasonFor(scan.catalogStatus);
  if (catalog && scan.catalogScannedAt) {
    notes.push(`Table and policy checks: the last scan failed (${catalog}). These results are from ${utc(scan.catalogScannedAt)}.`);
  }
  const advisor = reasonFor(scan.advisorStatus);
  if (advisor) {
    notes.push(scan.advisorScannedAt
      ? `Security Advisor: unable to assess on the last scan (${advisor}). Its results are from ${utc(scan.advisorScannedAt)}.`
      : `Security Advisor: unable to assess (${advisor}).`);
  }
  return notes;
}

const ORDER: (keyof SeverityCounts)[] = ["critical", "high", "medium", "low"];

export function countsText(counts: SeverityCounts): string {
  const parts = ORDER.filter((s) => counts[s] > 0).map((s) => `${counts[s]} ${s}`);
  return parts.length === 0 ? "no findings" : parts.join(" · ");
}

// One line per project on the workspace overview.
export function postureLine(summary: PostureSummary | undefined): { tone: "warn" | "info"; text: string } {
  const scan = summary?.scan ?? null;
  const state = postureState(scan);
  if (state.kind === "waiting") return { tone: "info", text: "Posture: first scan pending" };
  if (state.kind === "unable") return { tone: "warn", text: `Posture: unable to assess (${state.reason})` };
  if (state.kind === "queued" && !scan?.catalogScannedAt) return { tone: "info", text: "Posture: scan queued" };
  const counts = summary!.counts;
  const advisorGap = reasonFor(scan?.advisorStatus ?? null) ? "; Security Advisor unable to assess" : "";
  return {
    tone: counts.critical + counts.high > 0 || advisorGap ? "warn" : "info",
    text: `Posture: ${countsText(counts)}${advisorGap}`,
  };
}

export const SOURCE_LABEL = { catalog: "Supahound check", advisor: "Security Advisor" } as const;
