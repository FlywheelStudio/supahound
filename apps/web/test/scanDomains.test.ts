import type { DomainScanResult, ScanFindingRecord } from "@supahound/core/db/scanDomains";
import { domainId, projectId, tenantId } from "@supahound/core/tenancy/scope";
import { describe, expect, it, vi } from "vitest";
import { can } from "../lib/people";
import {
  canLinkDomains, domainNoticeFrom, DOMAIN_NOTICES, domainsPath, evidenceItems, findingCountsText, findingTitle, handleLink,
  handleUnlink, scanStateText,
} from "../lib/scanDomains";

// Scan domains per project and the Security scan tab (issue #100, decision 040).

const T = tenantId("aaaaaaaa-0000-4000-8000-000000000001");
const P = projectId("bbbbbbbb-0000-4000-8000-000000000002");
const D = "cccccccc-0000-4000-8000-000000000003";
const settings = `/w/${T}/p/${P}/settings`;

const finding = (over: Partial<ScanFindingRecord> = {}): ScanFindingRecord => ({
  id: "f1", severity: "high", type: "exposed-secret:stripe-secret-key", endpoint: "https://shop.test/app.js",
  evidence: {}, fix: "Rotate it.", supahoundMonitor: null, ...over,
});

const result = (over: Partial<DomainScanResult> = {}): DomainScanResult => ({
  id: domainId(D), apex: "shop.test", linkedAt: new Date("2026-11-12T09:00:00Z"),
  latest: { id: "s1", finishedAt: new Date("2026-11-11T10:00:00Z"), score: 72, findings: [] }, newer: null, ...over,
});

describe("who attaches a domain", () => {
  it("lets owners and admins only", () => {
    expect(canLinkDomains("owner")).toBe(true);
    expect(canLinkDomains("admin")).toBe(true);
    expect(canLinkDomains("editor")).toBe(false);
    expect(canLinkDomains("viewer")).toBe(false);
    expect(canLinkDomains(null)).toBe(false);
    // Not the same rule as settings: an editor changes settings but does not attach domains.
    expect(can("editor", "edit_settings")).toBe(true);
  });
});

describe("attach and detach", () => {
  it("returns to the domains section with the outcome", async () => {
    for (const outcome of ["linked", "already", "taken", "unverified"] as const) {
      const link = vi.fn(async () => ({ allowed: true, outcome }));
      expect(await handleLink(T, P, D, { link })).toBe(`${settings}?domain=${outcome}#scan-domains`);
      expect(link).toHaveBeenCalledWith(D);
    }
  });

  it("refuses a role that may not attach, and never reads an outcome for it", async () => {
    const link = vi.fn(async () => ({ allowed: false, outcome: null }));
    expect(await handleLink(T, P, D, { link })).toBe(`${settings}?domain=role#scan-domains`);
  });

  it("refuses a missing or malformed domain ID before any database call", async () => {
    const link = vi.fn();
    const unlink = vi.fn();
    for (const raw of [null, "", "not-a-uuid", `${D}x`, 42]) {
      expect(await handleLink(T, P, raw, { link })).toBe(`${settings}?domain=invalid#scan-domains`);
      expect(await handleUnlink(T, P, raw, { unlink })).toBe(`${settings}?domain=invalid#scan-domains`);
    }
    expect(link).not.toHaveBeenCalled();
    expect(unlink).not.toHaveBeenCalled();
  });

  it("reports a detach, a domain that was not attached, and a refused role", async () => {
    expect(await handleUnlink(T, P, D, { unlink: async () => ({ allowed: true, removed: true }) })).toBe(`${settings}?domain=unlinked#scan-domains`);
    expect(await handleUnlink(T, P, D, { unlink: async () => ({ allowed: true, removed: false }) })).toBe(`${settings}?domain=missing#scan-domains`);
    expect(await handleUnlink(T, P, D, { unlink: async () => ({ allowed: false, removed: false }) })).toBe(`${settings}?domain=role#scan-domains`);
  });

  it("shows only known notices, and never names the other project", () => {
    expect(domainNoticeFrom({ domain: "linked" })).toEqual(DOMAIN_NOTICES.linked);
    expect(domainNoticeFrom({ domain: "toString" })).toBeNull();
    expect(domainNoticeFrom({ domain: "<script>" })).toBeNull();
    expect(domainNoticeFrom({})).toBeNull();
    expect(DOMAIN_NOTICES.taken.text).toBe("That domain is attached to another project. Detach it there first.");
    expect(domainsPath(T, P)).toBe(`${settings}#scan-domains`);
  });
});

describe("the Security scan tab", () => {
  it("says when the last scan finished, its score, and a newer scan that has not finished", () => {
    expect(scanStateText(result())).toBe("Last finished scan 2026-11-11 10:00 UTC, score 72/100.");
    expect(scanStateText(result({ newer: "running" }))).toBe("Last finished scan 2026-11-11 10:00 UTC, score 72/100. A newer scan is running.");
    expect(scanStateText(result({ newer: "failed" }))).toBe("Last finished scan 2026-11-11 10:00 UTC, score 72/100. The newest scan failed.");
    expect(scanStateText(result({ latest: null }))).toBe("No finished scan yet.");
    expect(scanStateText(result({ latest: null, newer: "queued" }))).toBe("No finished scan yet. A newer scan is queued.");
  });

  it("counts findings by severity, most severe first", () => {
    const f = [finding({ severity: "low" }), finding({ severity: "critical" }), finding({ severity: "low" }), finding({ severity: "info" })];
    expect(findingCountsText(f)).toBe("1 critical · 2 low · 1 info");
    expect(findingCountsText([])).toBe("no findings");
  });

  it("titles a finding by its rule name when that is plain text, else by its type", () => {
    expect(findingTitle(finding({ evidence: { name: "Stripe secret key" } }))).toBe("Stripe secret key");
    expect(findingTitle(finding({ evidence: { name: "<img src=x onerror=alert(1)>" } }))).toBe("exposed-secret:stripe-secret-key");
    expect(findingTitle(finding({ evidence: { name: 7 } }))).toBe("exposed-secret:stripe-secret-key");
  });
});

describe("evidence on the page", () => {
  it("shows the structured keys of a secret finding, never more than the last four characters", () => {
    const items = evidenceItems({
      rule: "stripe-secret-key", name: "Stripe secret key", source: "script", fingerprint: "0123456789ab", last4: "Wxyz",
      offset: 1200, occurrences: 3,
    });
    expect(items).toEqual([
      { label: "Rule", value: "stripe-secret-key" },
      { label: "Found in", value: "Script" },
      { label: "Fingerprint", value: "0123456789ab" },
      { label: "Ends in", value: "…Wxyz" },
      { label: "Occurrences", value: "3" },
    ]);
  });

  it("shows key names of an exposed .env file, never values", () => {
    expect(evidenceItems({ path: "/.env", keyCount: 2, keyNames: ["DATABASE_URL", "STRIPE_KEY"] })).toEqual([
      { label: "Path", value: "/.env" },
      { label: "Keys", value: "2" },
      { label: "Key names", value: "DATABASE_URL, STRIPE_KEY" },
    ]);
    // A "name" that holds an assignment is not a key name: the whole list is dropped.
    expect(evidenceItems({ keyNames: ["DATABASE_URL=postgres://u:p@h/db"] })).toEqual([]);
  });

  it("drops unknown keys and values of the wrong shape, so a secret stored by mistake never shows", () => {
    const fakeKey = ["sk", "live", "x".repeat(24)].join("_");
    expect(evidenceItems({
      secret: fakeKey, value: fakeKey, token: fakeKey,
      last4: fakeKey, fingerprint: fakeKey, rule: fakeKey, source: "elsewhere", occurrences: -1, projectRef: "short",
    })).toEqual([]);
    expect(evidenceItems({ hasRemote: true, profiles: 2, projectRef: "abcdefghijklmnopqrst" })).toEqual([
      { label: "Supabase project", value: "abcdefghijklmnopqrst" },
      { label: "Has a remote", value: "Yes" },
      { label: "Profiles", value: "2" },
    ]);
  });
});
