import type { PostureScanRecord } from "@supahound/core/db/posture";
import { projectId, tenantId } from "@supahound/core/tenancy/scope";
import { describe, expect, it } from "vitest";
import {
  canScan, countsText, handleScanNow, isPending, postureLine, postureState, scanNoticeFrom, sourceNotes, stateText,
} from "../lib/posture";

// Posture scan in the web app (issue #11, decision 038). A scan that could not run never reads
// as "no findings".

const T = tenantId("aaaaaaaa-0000-4000-8000-000000000001");
const P = projectId("bbbbbbbb-0000-4000-8000-000000000002");
const PAGE = `/w/${T}/p/${P}/posture`;
const AT = new Date("2026-11-12T10:00:00Z");

const scan = (o: Partial<PostureScanRecord> = {}): PostureScanRecord => ({
  id: "s", requestedAt: null, attemptedAt: AT, finishedAt: AT, catalogStatus: "ok", catalogScannedAt: AT,
  advisorStatus: "ok", advisorScannedAt: AT, tablesChecked: 3, viewsChecked: 1, policiesChecked: 4, ...o,
});
const counts = (o: Partial<Record<"critical" | "high" | "medium" | "low", number>> = {}) => ({ critical: 0, high: 0, medium: 0, low: 0, ...o });

describe("Scan now", () => {
  it("lets owners, admins and editors scan, not viewers", () => {
    expect((["owner", "admin", "editor", "viewer"] as const).map(canScan)).toEqual([true, true, true, false]);
    expect(canScan(null)).toBe(false);
  });

  it("returns to the Posture page with the outcome", async () => {
    for (const outcome of ["queued", "already_queued", "too_soon"] as const) {
      expect(await handleScanNow(T, P, { request: async () => ({ allowed: true, outcome }) })).toBe(`${PAGE}?scan=${outcome}`);
    }
  });

  it("refuses a role that may not scan", async () => {
    expect(await handleScanNow(T, P, { request: async () => ({ allowed: false, outcome: null }) })).toBe(`${PAGE}?scan=role`);
  });

  it("shows known notices only", () => {
    expect(scanNoticeFrom({ scan: "queued" })).toMatchObject({ tone: "ok" });
    expect(scanNoticeFrom({ scan: "role" })).toMatchObject({ tone: "error" });
    expect(scanNoticeFrom({ scan: "toString" })).toBeNull();
    expect(scanNoticeFrom({ scan: "<script>" })).toBeNull();
    expect(scanNoticeFrom({})).toBeNull();
  });
});

describe("scan state", () => {
  it("waits before the first scan, and never calls that clean", () => {
    expect(postureState(null)).toEqual({ kind: "waiting" });
    expect(postureState(scan({ catalogStatus: null, catalogScannedAt: null, finishedAt: null }))).toEqual({ kind: "waiting" });
    expect(postureLine(undefined)).toEqual({ tone: "info", text: "Posture: first scan pending" });
  });

  it("is queued while a request is newer than the last attempt", () => {
    const s = scan({ requestedAt: new Date(AT.getTime() + 1000) });
    expect(isPending(s)).toBe(true);
    expect(postureState(s)).toEqual({ kind: "queued" });
    expect(isPending(scan({ requestedAt: new Date(AT.getTime() - 1000) }))).toBe(false);
    expect(isPending(scan({ requestedAt: AT, attemptedAt: null }))).toBe(true);
  });

  it("is unable to assess when the catalog never read, with the reason", () => {
    const s = scan({ catalogStatus: "unauthorized", catalogScannedAt: null });
    expect(postureState(s)).toEqual({ kind: "unable", reason: "Supabase refused access" });
    expect(stateText(postureState(s))).toMatch(/^Unable to assess: Supabase refused access/);
    expect(postureLine({ projectId: P, scan: s, counts: counts() })).toEqual({ tone: "warn", text: "Posture: unable to assess (Supabase refused access)" });
  });

  it("shows the last scan time and counts once scanned", () => {
    expect(stateText(postureState(scan()))).toBe("Last scan 2026-11-12 10:00 UTC.");
    expect(countsText(counts({ critical: 1, low: 2 }))).toBe("1 critical · 2 low");
    expect(countsText(counts())).toBe("no findings");
    expect(postureLine({ projectId: P, scan: scan(), counts: counts({ high: 2 }) })).toEqual({ tone: "warn", text: "Posture: 2 high" });
    expect(postureLine({ projectId: P, scan: scan(), counts: counts({ low: 1 }) })).toEqual({ tone: "info", text: "Posture: 1 low" });
  });

  it("never says 'no findings' alone when the Security Advisor could not run", () => {
    const s = scan({ advisorStatus: "unauthorized", advisorScannedAt: null });
    expect(postureLine({ projectId: P, scan: s, counts: counts() })).toEqual({
      tone: "warn", text: "Posture: no findings; Security Advisor unable to assess",
    });
    expect(sourceNotes(s)).toEqual(["Security Advisor: unable to assess (Supabase refused access)."]);
  });

  it("says when results come from an older scan", () => {
    const old = new Date("2026-11-11T10:00:00Z");
    const s = scan({ catalogStatus: "network_error", catalogScannedAt: old, advisorStatus: "unavailable", advisorScannedAt: old });
    expect(postureState(s)).toEqual({ kind: "scanned", at: old });
    expect(sourceNotes(s)).toEqual([
      "Table and policy checks: the last scan failed (Supabase did not answer). These results are from 2026-11-11 10:00 UTC.",
      "Security Advisor: unable to assess on the last scan (the check is not available for this project). Its results are from 2026-11-11 10:00 UTC.",
    ]);
    expect(sourceNotes(scan())).toEqual([]);
  });
});
