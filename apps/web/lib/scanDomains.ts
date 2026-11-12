import type { DomainScanResult, LinkOutcome, ScanFindingRecord } from "@supahound/core/db/scanDomains";
import type { ProjectRole } from "@supahound/core/db/people";
import { domainId, type DomainId, type ProjectId, type TenantId } from "@supahound/core/tenancy/scope";
import { projectPath, utc } from "./nav";
import { can, parseUuid } from "./people";

// Scan domains per project and the Security scan tab (issue #100, decision 040) as pure
// functions, so every branch is testable. The server actions check the role in the same
// transaction as the write; RLS and a trigger refuse the same writes again in the database
// (migration 20261112040000_scan_domains_per_project.sql).

// Owners and admins attach and detach domains.
export const canLinkDomains = (role: ProjectRole | null): boolean => can(role, "link_domains");

export type DomainNotice = LinkOutcome | "unlinked" | "missing" | "role" | "invalid";

export const DOMAIN_NOTICES: Record<DomainNotice, { tone: "ok" | "error"; text: string }> = {
  linked: { tone: "ok", text: "Domain attached. Its latest scan shows on the Security scan tab." },
  unlinked: { tone: "ok", text: "Domain detached. Its findings no longer show on this project." },
  already: { tone: "ok", text: "That domain is already attached to this project." },
  taken: { tone: "error", text: "That domain is attached to another project. Detach it there first." },
  unverified: { tone: "error", text: "That domain is not verified, or you cannot see it. Only verified domains can be attached." },
  missing: { tone: "error", text: "That domain is no longer attached to this project." },
  role: { tone: "error", text: "Only the project's owners and admins can attach or detach a domain." },
  invalid: { tone: "error", text: "Choose a domain." },
};

export function domainsPath(tenant: TenantId, project: ProjectId, notice?: DomainNotice): string {
  return `${projectPath(tenant, project, "general")}${notice ? `?domain=${notice}` : ""}#scan-domains`;
}

export function domainNoticeFrom(query: Record<string, string | undefined>): { tone: "ok" | "error"; text: string } | null {
  const n = query.domain;
  return n && Object.hasOwn(DOMAIN_NOTICES, n) ? DOMAIN_NOTICES[n as DomainNotice] : null;
}

export function parseDomainId(value: unknown): DomainId | null {
  const id = parseUuid(value);
  return id ? domainId(id) : null;
}

export interface LinkDeps {
  // Inside the project transaction: whether the role may link and, only then, the outcome.
  link: (domain: DomainId) => Promise<{ allowed: boolean; outcome: LinkOutcome | null }>;
}

export async function handleLink(tenant: TenantId, project: ProjectId, raw: unknown, deps: LinkDeps): Promise<string> {
  const domain = parseDomainId(raw);
  if (!domain) return domainsPath(tenant, project, "invalid");
  const { allowed, outcome } = await deps.link(domain);
  if (!allowed || outcome === null) return domainsPath(tenant, project, "role");
  return domainsPath(tenant, project, outcome);
}

export interface UnlinkDeps {
  unlink: (domain: DomainId) => Promise<{ allowed: boolean; removed: boolean }>;
}

export async function handleUnlink(tenant: TenantId, project: ProjectId, raw: unknown, deps: UnlinkDeps): Promise<string> {
  const domain = parseDomainId(raw);
  if (!domain) return domainsPath(tenant, project, "invalid");
  const { allowed, removed } = await deps.unlink(domain);
  if (!allowed) return domainsPath(tenant, project, "role");
  return domainsPath(tenant, project, removed ? "unlinked" : "missing");
}

// --- The Security scan tab ---------------------------------------------------------------------------

export function scanStateText(r: DomainScanResult): string {
  const newer =
    r.newer === "failed" ? " The newest scan failed." : r.newer ? ` A newer scan is ${r.newer === "queued" ? "queued" : "running"}.` : "";
  if (!r.latest) return `No finished scan yet.${newer}`;
  const when = r.latest.finishedAt ? `Last finished scan ${utc(r.latest.finishedAt)}` : "Last finished scan";
  const score = r.latest.score !== null ? `, score ${r.latest.score}/100` : "";
  return `${when}${score}.${newer}`;
}

const ORDER = ["critical", "high", "medium", "low", "info"] as const;

export function findingCountsText(findings: ScanFindingRecord[]): string {
  const parts = ORDER.map((s) => [s, findings.filter((f) => f.severity === s).length] as const)
    .filter(([, n]) => n > 0)
    .map(([s, n]) => `${n} ${s}`);
  return parts.length === 0 ? "no findings" : parts.join(" · ");
}

// Evidence is structured, but a later scan writer could store anything in the JSON. The page shows
// only these keys, and only when the value has the expected shape. Never a secret: a secret
// finding stores a fingerprint and at most the last four characters (decision 026).
const PLAIN = /^[A-Za-z0-9 _.:/()-]{1,100}$/;
const KEY_NAME = /^[A-Za-z_][A-Za-z0-9_.-]{0,63}$/;
const SOURCE_LABEL: Record<string, string> = { page: "Page", script: "Script", "source-map": "Source map", "leak-path": "Leak path" };

type Rule = { label: string; show: (v: unknown) => string | null };
const str = (re: RegExp) => (v: unknown) => (typeof v === "string" && re.test(v) ? v : null);
const count = (v: unknown) => (typeof v === "number" && Number.isInteger(v) && v >= 0 ? String(v) : null);

const EVIDENCE: Record<string, Rule> = {
  rule: { label: "Rule", show: str(/^[a-z0-9-]{1,64}$/) },
  source: { label: "Found in", show: (v) => (typeof v === "string" && Object.hasOwn(SOURCE_LABEL, v) ? SOURCE_LABEL[v]! : null) },
  path: { label: "Path", show: str(/^\/[A-Za-z0-9._/-]{1,100}$/) },
  fingerprint: { label: "Fingerprint", show: str(/^[0-9a-f]{8,64}$/) },
  last4: { label: "Ends in", show: (v) => (typeof v === "string" && /^[\x21-\x7e]{1,4}$/.test(v) ? `…${v}` : null) },
  occurrences: { label: "Occurrences", show: count },
  projectRef: { label: "Supabase project", show: str(/^[a-z0-9]{20}$/) },
  keyCount: { label: "Keys", show: count },
  keyNames: {
    label: "Key names",
    show: (v) => (Array.isArray(v) && v.length > 0 && v.length <= 50 && v.every((k) => typeof k === "string" && KEY_NAME.test(k)) ? v.join(", ") : null),
  },
  hasRemote: { label: "Has a remote", show: (v) => (typeof v === "boolean" ? (v ? "Yes" : "No") : null) },
  profiles: { label: "Profiles", show: count },
};

export function evidenceItems(evidence: Record<string, unknown>): { label: string; value: string }[] {
  const out: { label: string; value: string }[] = [];
  for (const [key, rule] of Object.entries(EVIDENCE)) {
    if (!Object.hasOwn(evidence, key)) continue;
    const value = rule.show(evidence[key]);
    if (value !== null) out.push({ label: rule.label, value });
  }
  return out;
}

// The finding's title: the rule's name when it is plain text, else its type.
export function findingTitle(f: Pick<ScanFindingRecord, "type" | "evidence">): string {
  const name = f.evidence.name;
  return typeof name === "string" && PLAIN.test(name) ? name : f.type;
}
