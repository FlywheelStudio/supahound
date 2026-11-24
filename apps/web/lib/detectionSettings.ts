import { expectedNetworkName, publicTableName, type MarkOutcome } from "@supahound/core/db/detectionSettings";
import type { ProjectRole } from "@supahound/core/db/people";
import { isRpcBurstHits, RPC_BURST_MAX, RPC_BURST_MIN } from "@supahound/core/detectors/rpcExposure";
import { acceptedAsPublic } from "@supahound/core/posture/findings";
import type { PostureFinding } from "@supahound/core/posture/types";
import type { ProjectId, TenantId } from "@supahound/core/tenancy/scope";
import { projectPath, workspacePath } from "./nav";
import { can } from "./people";

// Per-project detection settings (issue #160, decision 045) as pure functions, so every branch is
// testable. The server actions check the role in the same transaction as the write; RLS refuses
// the same writes again (migration 20261122150000_project_detection_settings.sql).

// --- Intentionally public tables (Posture page) -----------------------------------------------------

// Owners and admins mark and unmark: a mark silences detector 11 for the table.
export const canMarkPublic = (role: ProjectRole | null): boolean => can(role, "mark_public");

export type PublicNotice = Exclude<MarkOutcome, "invalid"> | "unmarked" | "not_marked" | "role" | "invalid";

export const PUBLIC_NOTICES: Record<PublicNotice, { tone: "ok" | "error"; text: string }> = {
  marked: { tone: "ok", text: "Marked intentionally public. Supahound stops alerting on anonymous reads of it from the next poll." },
  already: { tone: "ok", text: "That table is already marked intentionally public." },
  unmarked: { tone: "ok", text: "Mark removed. Supahound alerts on anonymous reads of it again from the next poll." },
  not_marked: { tone: "error", text: "That table is not marked intentionally public." },
  role: { tone: "error", text: "Only the project's owners and admins can mark a table intentionally public." },
  invalid: { tone: "error", text: "That is not a table name Supahound can mark." },
};

export function publicTablesPath(tenant: TenantId, project: ProjectId, notice?: PublicNotice): string {
  return `${projectPath(tenant, project, "posture")}${notice ? `?public=${notice}` : ""}#public-tables`;
}

export function publicNoticeFrom(query: Record<string, string | undefined>): { tone: "ok" | "error"; text: string } | null {
  const n = query.public;
  return n && Object.hasOwn(PUBLIC_NOTICES, n) ? PUBLIC_NOTICES[n as PublicNotice] : null;
}

export interface MarkDeps {
  // Inside the project transaction: whether the role may mark and, only then, the outcome.
  mark: (table: string) => Promise<{ allowed: boolean; outcome: MarkOutcome | null }>;
}

export async function handleMarkPublic(tenant: TenantId, project: ProjectId, raw: unknown, deps: MarkDeps): Promise<string> {
  const table = publicTableName(raw);
  if (table === null) return publicTablesPath(tenant, project, "invalid");
  const { allowed, outcome } = await deps.mark(table);
  if (!allowed || outcome === null) return publicTablesPath(tenant, project, "role");
  return publicTablesPath(tenant, project, outcome === "invalid" ? "invalid" : outcome);
}

export interface UnmarkDeps {
  unmark: (table: string) => Promise<{ allowed: boolean; removed: boolean }>;
}

export async function handleUnmarkPublic(tenant: TenantId, project: ProjectId, raw: unknown, deps: UnmarkDeps): Promise<string> {
  const table = publicTableName(raw);
  if (table === null) return publicTablesPath(tenant, project, "invalid");
  const { allowed, removed } = await deps.unmark(table);
  if (!allowed) return publicTablesPath(tenant, project, "role");
  return publicTablesPath(tenant, project, removed ? "unmarked" : "not_marked");
}

export const ACCEPTED_LABEL = "Accepted (intentionally public)";
export const WRITES_OPEN_TEXT =
  "This table is marked intentionally public, but this finding also lets the Data API change it, so it stays open.";

// How a finding reads on the Posture page: accepted by the mark; on a marked table but about
// writes (still open, with a note); or plainly open.
export function publicStatus(f: PostureFinding, publicTables: ReadonlySet<string>): "accepted" | "writes_open" | "open" {
  if (acceptedAsPublic(f, publicTables)) return "accepted";
  const onMarkedTable = f.schema === "public" && f.objectType === "table" && f.object !== null && publicTables.has(f.object);
  return onMarkedTable && (f.check === "rls_disabled" || f.check === "permissive_policy") ? "writes_open" : "open";
}

// --- RPC burst threshold (Notifications page, next to the email alert threshold) --------------------

// Owners, admins and editors change it, as they change the email alert threshold (decision 030).
export const canSetBurst = (role: ProjectRole | null): boolean => can(role, "edit_settings");

export const BURST_RANGE_TEXT = `${RPC_BURST_MIN.toLocaleString("en-US")} to ${RPC_BURST_MAX.toLocaleString("en-US")}`;

// A whole number typed into the form: digits only (a thousands separator is allowed), in range.
export function parseBurstHits(value: unknown): number | null {
  if (typeof value !== "string") return null;
  const digits = value.trim().replace(/,/g, "");
  if (!/^\d{1,6}$/.test(digits)) return null;
  const n = Number(digits);
  return isRpcBurstHits(n) ? n : null;
}

export type BurstNotice = "saved" | "role" | "range" | "missing";

export function burstPath(tenant: TenantId, project: ProjectId, notice: BurstNotice, hits?: number): string {
  if (notice === "missing") return `${workspacePath(tenant, "projects")}?error=burst_missing`;
  return `${projectPath(tenant, project, "notifications")}?${notice === "saved" ? `burst=${hits}` : `error=burst_${notice}`}#rpc-burst`;
}

export interface BurstDeps {
  // Inside the project transaction: whether the role may change it and, only then, whether the
  // project row was updated. Must not write when not allowed.
  apply: (hits: number) => Promise<{ allowed: boolean; updated: boolean }>;
}

export async function handleBurstSetting(tenant: TenantId, project: ProjectId, value: unknown, deps: BurstDeps): Promise<string> {
  const hits = parseBurstHits(value);
  if (hits === null) return burstPath(tenant, project, "range");
  const { allowed, updated } = await deps.apply(hits);
  if (!allowed) return burstPath(tenant, project, "role");
  if (!updated) return burstPath(tenant, project, "missing");
  return burstPath(tenant, project, "saved", hits);
}

// The saved notice reads the number back from the URL; only a value in range is shown.
export function savedBurstFrom(query: Record<string, string | undefined>): number | null {
  return parseBurstHits(query.burst);
}

// --- Expected networks (Notifications page and service-role incidents, issue #185, decision 050) ----

// Owners and admins mark and unmark: a mark silences detector 4's network signals for the network.
export const canMarkExpected = (role: ProjectRole | null): boolean => can(role, "mark_expected");

// The signals a mark silences. An incident without one of them has nothing to mark.
export const NETWORK_SIGNALS: ReadonlySet<string> = new Set(["non_hosting_network", "new_network"]);

export type ExpectedNotice = PublicNotice;

export const EXPECTED_NOTICES: Record<ExpectedNotice, { tone: "ok" | "error"; text: string }> = {
  marked: { tone: "ok", text: "Marked as expected. Supahound stops alerting on the service-role key from this network from the next poll. A browser or app holding the key still alerts." },
  already: { tone: "ok", text: "That network is already marked as expected." },
  unmarked: { tone: "ok", text: "Mark removed. Supahound alerts on the service-role key from this network again from the next poll." },
  not_marked: { tone: "error", text: "That network is not marked as expected." },
  role: { tone: "error", text: "Only the project's owners and admins can mark a network as expected." },
  invalid: { tone: "error", text: "That is not a network name Supahound can mark." },
};

export function expectedNetworksPath(tenant: TenantId, project: ProjectId, notice?: ExpectedNotice): string {
  return `${projectPath(tenant, project, "notifications")}${notice ? `?expected=${notice}` : ""}#expected-networks`;
}

export function expectedNoticeFrom(query: Record<string, string | undefined>): { tone: "ok" | "error"; text: string } | null {
  const n = query.expected;
  return n && Object.hasOwn(EXPECTED_NOTICES, n) ? EXPECTED_NOTICES[n as ExpectedNotice] : null;
}

export interface MarkExpectedDeps {
  // Inside the project transaction: whether the role may mark and, only then, the outcome.
  mark: (network: string) => Promise<{ allowed: boolean; outcome: MarkOutcome | null }>;
}

export async function handleMarkExpected(tenant: TenantId, project: ProjectId, raw: unknown, deps: MarkExpectedDeps): Promise<string> {
  const network = expectedNetworkName(raw);
  if (network === null) return expectedNetworksPath(tenant, project, "invalid");
  const { allowed, outcome } = await deps.mark(network);
  if (!allowed || outcome === null) return expectedNetworksPath(tenant, project, "role");
  return expectedNetworksPath(tenant, project, outcome === "invalid" ? "invalid" : outcome);
}

export interface UnmarkExpectedDeps {
  unmark: (network: string) => Promise<{ allowed: boolean; removed: boolean }>;
}

export async function handleUnmarkExpected(tenant: TenantId, project: ProjectId, raw: unknown, deps: UnmarkExpectedDeps): Promise<string> {
  const network = expectedNetworkName(raw);
  if (network === null) return expectedNetworksPath(tenant, project, "invalid");
  const { allowed, removed } = await deps.unmark(network);
  if (!allowed) return expectedNetworksPath(tenant, project, "role");
  return expectedNetworksPath(tenant, project, removed ? "unmarked" : "not_marked");
}

// The networks an incident's page offers to mark: those its findings name, minus the marked ones,
// and only when the incident carries a network signal.
export function markableNetworks(
  incident: { signals: readonly string[] }, networks: readonly string[], marked: ReadonlySet<string>,
): string[] {
  if (!incident.signals.some((s) => NETWORK_SIGNALS.has(s))) return [];
  return networks.filter((n) => !marked.has(n));
}
