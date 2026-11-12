import { tenantId } from "@supahound/core/tenancy/scope";
import { describe, expect, it } from "vitest";
import {
  backPath, canClose, canDisconnect, closeRedirect, connectionState, daysLeft, disconnectedNotice, disconnectRedirect, MESSAGES, parseBack, reopenRedirect,
} from "../lib/dataControls";

// Data controls in the web app (decision 037): roles, redirects and notices.

const T = tenantId("aaaaaaaa-0000-4000-8000-000000000001");

describe("data-control roles", () => {
  it("lets owners and admins disconnect, and only owners close", () => {
    expect([canDisconnect("owner"), canDisconnect("admin"), canDisconnect("member")]).toEqual([true, true, false]);
    expect([canClose("owner"), canClose("admin"), canClose("member")]).toEqual([true, false, false]);
  });
});

describe("redirects", () => {
  it("sends a closed workspace to its closed page and every refusal back with a known message", () => {
    // Closing keeps the workspace open until its period ends, so the owner lands on settings.
    expect(closeRedirect(T, "closed")).toBe(`/w/${T}/settings?closing=1`);
    expect(closeRedirect(T, "already_closed")).toBe(`/w/${T}/settings?closing=1`);
    for (const r of ["mismatch", "role", "failed"] as const) {
      const url = new URL(closeRedirect(T, r), "https://x");
      expect(url.pathname).toBe(`/w/${T}/settings`);
      expect(MESSAGES[url.searchParams.get("error")!]).toBeTruthy();
    }
    expect(reopenRedirect(T, "reopened")).toBe(`/w/${T}`);
    for (const r of ["role", "too_late"] as const) {
      expect(MESSAGES[new URL(reopenRedirect(T, r), "https://x").searchParams.get("error")!]).toBeTruthy();
    }
  });

  it("returns a disconnect to the page it came from, and keeps the confirm open after a mismatch", () => {
    const ok = disconnectRedirect(T, "closed", "c1", { result: "disconnected", revoked: false, projectsPaused: 2 });
    expect(ok).toBe(`/w/${T}/closed?disconnected=local&removed=2`);
    expect(disconnectRedirect(T, "settings", "c1", { result: "mismatch", revoked: false, projectsPaused: 0 }))
      .toBe(`/w/${T}/settings?disconnect=c1&error=disconnect_mismatch`);
    for (const r of ["role", "missing"] as const) {
      const url = new URL(disconnectRedirect(T, "settings", "c1", { result: r, revoked: false, projectsPaused: 0 }), "https://x");
      expect(MESSAGES[url.searchParams.get("error")!]).toBeTruthy();
    }
  });

  it("accepts only the two known pages as a return target", () => {
    expect(parseBack("closed")).toBe("closed");
    for (const v of ["settings", "https://evil.example", null, "../billing"]) expect(parseBack(v)).toBe("settings");
    expect(backPath(T, "settings")).toBe(`/w/${T}/settings`);
  });
});

describe("disconnectedNotice", () => {
  it("says whether Supabase confirmed the revocation, and what to do when it did not", () => {
    expect(disconnectedNotice("revoked", "1")).toBe(
      "Supabase disconnected. Supahound deleted its access token and stopped watching 1 project. Everyone on it got an email. Supabase confirmed that the grant is revoked.",
    );
    expect(disconnectedNotice("local", "0")).toContain("remove the Supahound app in your Supabase organization's OAuth Apps settings");
    expect(disconnectedNotice("local", "0")).not.toContain("stopped watching");
    expect(disconnectedNotice("other", "3")).toBeNull();
    expect(disconnectedNotice(undefined, undefined)).toBeNull();
  });
});

describe("daysLeft", () => {
  it("rounds up and never goes below zero", () => {
    const now = new Date("2026-11-12T12:00:00Z");
    expect(daysLeft({ purgeAfter: new Date("2026-12-12T12:00:00Z") }, now)).toBe(30);
    expect(daysLeft({ purgeAfter: new Date("2026-11-12T13:00:00Z") }, now)).toBe(1);
    expect(daysLeft({ purgeAfter: new Date("2026-11-11T12:00:00Z") }, now)).toBe(0);
  });
});

describe("connectionState", () => {
  const base = { disconnectedAt: new Date("2026-11-12T10:00:00Z"), deleteAfter: new Date("2026-12-12T10:00:00Z") };
  it("says who ended the connection and when its history goes, or that it stays while the workspace pays", () => {
    expect(connectionState({ ...base, disconnectReason: "user" }, false))
      .toBe("Disconnected on 2026-11-12. History deleted on 2026-12-12 unless you reconnect the same Supabase organization.");
    expect(connectionState({ ...base, disconnectReason: "revoked" }, true))
      .toBe("Access revoked in Supabase on 2026-11-12. History kept while the workspace pays.");
    expect(connectionState({ disconnectedAt: null, disconnectReason: null, deleteAfter: null }, false)).toBeNull();
  });
});
