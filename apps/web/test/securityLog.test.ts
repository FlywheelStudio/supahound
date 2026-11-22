import type { SecurityEventItem } from "@supahound/core/db/securityEvents";
import { SECURITY_ACTIONS } from "@supahound/core/db/securityEvents";
import { tenantId } from "@supahound/core/tenancy/scope";
import { afterEach, describe, expect, it, vi } from "vitest";
import { handleOAuthCallback } from "../lib/connect";
import { handleSendEmailHook } from "../lib/email/hook";
import {
  actorLabel, canReadSecurityLog, describeEvent, encodeSecurityCursor, parseSecurityCursor, resultLabel, securityLogPath,
} from "../lib/securityLog";

// Security log page helpers and the tenant-less security events (issue #138, decision 044).

const ID = "0f8fad5b-d9cb-469f-a165-70867728950e";
const T = tenantId("aaaaaaaa-0000-4000-8000-000000000001");

const event = (over: Partial<SecurityEventItem>): SecurityEventItem => ({
  id: ID, action: "sign_in", result: "success", createdAt: new Date("2026-11-22T10:00:00Z"), actorId: ID, actorEmail: "owner@example.test",
  projectId: null, projectName: null, targetId: null, targetEmail: null, detail: {}, ...over,
});

describe("security log page helpers", () => {
  it("is for workspace owners only", () => {
    expect([canReadSecurityLog("owner"), canReadSecurityLog("admin"), canReadSecurityLog("member")]).toEqual([true, false, false]);
    expect(securityLogPath(T)).toBe(`/w/${T}/settings/security`);
  });

  it("round-trips the keyset cursor with microseconds, and rejects a mangled one", () => {
    const c = { createdUs: "1794571200123456", id: ID };
    expect(parseSecurityCursor(encodeSecurityCursor(c))).toEqual(c);
    expect(parseSecurityCursor(undefined)).toBeNull();
    for (const bad of ["", "x_y", `1_${ID}_2`, `-1_${ID}`, `1794571200123456_not-a-uuid`]) expect(parseSecurityCursor(bad), bad).toBe("invalid");
    expect(parseSecurityCursor(["a", "b"])).toBe("invalid");
  });

  it("describes every action", () => {
    for (const action of SECURITY_ACTIONS) expect(describeEvent(event({ action })), action).toMatch(/^[A-Z]/);
    expect(describeEvent(event({ action: "role_changed", targetEmail: "v@example.test", projectName: "Shop", detail: { role: "editor", from: "viewer" } })))
      .toBe("Changed the role of v@example.test on Shop from Viewer to Editor");
    expect(describeEvent(event({ action: "invite_sent", projectName: "Shop", detail: { role: "admin", kind: "resent" } }))).toBe("Resent an invite as Admin on Shop");
    expect(describeEvent(event({ action: "connection_removed", detail: { reason: "revoked" } }))).toBe("Supabase access was revoked outside Supahound");
    expect(describeEvent(event({ action: "data_deleted", detail: { kind: "removed_projects", count: 1 } }))).toBe("Deleted 1 removed project and their history");
    expect(describeEvent(event({ action: "project_removed" }))).toBe("Removed the project (since deleted)");
  });

  it("names the actor, the system, or someone who has left", () => {
    expect(actorLabel(event({}))).toBe("owner@example.test");
    expect(actorLabel(event({ actorId: null, actorEmail: null }))).toBe("Supahound");
    expect(actorLabel(event({ actorEmail: null }))).toBe("Former member 0f8fad5b");
  });

  it("says what was refused and why", () => {
    expect(resultLabel(event({}))).toBe("Done");
    expect(resultLabel(event({ result: "denied", detail: { reason: "role" } }))).toBe("Refused: their role does not allow it");
    expect(resultLabel(event({ result: "denied", detail: { reason: "wrong_email" } }))).toBe("Refused: signed in with a different address");
    expect(resultLabel(event({ result: "failed", detail: { reason: "email" } }))).toBe("Failed: the email did not send");
    expect(resultLabel(event({ result: "failed" }))).toBe("Failed");
  });
});

describe("tenant-less security events go to Workers logs as one JSON line, with no personal data", () => {
  afterEach(() => vi.restoreAllMocks());
  const lines = () => {
    const spy = vi.spyOn(console, "log").mockImplementation(() => undefined);
    return () => spy.mock.calls.map((c) => JSON.parse(String(c[0])) as Record<string, unknown>).filter((l) => l.event === "security_event");
  };

  it("logs a rejected OAuth state, malformed or unknown", async () => {
    const logged = lines();
    const deps = {
      consume: async () => null, exchange: async () => { throw new Error("not called"); }, store: async () => undefined, isNotAMember: () => false,
    };
    const user = "11111111-1111-4111-8111-111111111111" as never;
    expect(await handleOAuthCallback(new URLSearchParams({ state: "garbage", code: "c" }), user, deps)).toBe("/app?error=connect");
    expect(await handleOAuthCallback(new URLSearchParams({ state: `${T}.${"a".repeat(43)}`, code: "c" }), user, deps)).toBe(`/w/${T}?error=connect`);
    expect(logged()).toEqual([
      { event: "security_event", kind: "oauth_state_rejected", reason: "malformed" },
      { event: "security_event", kind: "oauth_state_rejected", reason: "unknown" },
    ]);
  });

  it("logs a Send Email Hook call with a bad signature, and nothing from its body", async () => {
    const logged = lines();
    const res = await handleSendEmailHook(JSON.stringify({ user: { email: "victim@example.test" } }), new Headers(), {
      secret: `v1,whsec_${Buffer.from("x".repeat(32)).toString("base64")}`, appUrl: "https://app.example.test",
      from: { email: "no-reply@example.test", name: "Supahound" }, send: async () => undefined,
    });
    expect(res.status).toBe(401);
    expect(logged()).toEqual([{ event: "security_event", kind: "email_hook_bad_signature" }]);
  });
});
