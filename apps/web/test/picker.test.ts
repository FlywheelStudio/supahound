import type { Role } from "@supahound/core/db/user";
import { ManagementApiError, type SupabaseProject } from "@supahound/core/supabase/management";
import { OAuthError } from "@supahound/core/supabase/oauth";
import { connectionId, tenantId } from "@supahound/core/tenancy/scope";
import { describe, expect, it } from "vitest";
import { handleWatch, keepOutcome, MAX_PICK, picksPath, removalOutcome, submittedRefs, type WatchDeps } from "../lib/picker";

const T = tenantId("aaaaaaaa-0000-4000-8000-000000000001");
const C = connectionId("cccccccc-0000-4000-8000-000000000001");
const SHOP = "shopshopshopshopshop";
const BLOG = "blogblogblogblogblog";
const PAUSED = "pausedpausedpausedpa";
const project = (ref: string, name: string, status: string | null = "ACTIVE_HEALTHY"): SupabaseProject =>
  ({ ref, name, organizationId: "org", region: "us-east-1", status });
const API = [project(SHOP, "Shop"), project(BLOG, "Blog"), project(PAUSED, "Old", "INACTIVE")];

function deps(over: Partial<WatchDeps> & { role?: Role } = {}) {
  const log: string[] = [];
  const inserted: { ref: string; name: string }[][] = [];
  const d: WatchDeps = {
    prepare: async () => { log.push("prepare"); return { role: over.role ?? "owner", token: "tok" }; },
    list: async () => { log.push("list"); return API; },
    insert: async (_c, ps) => { log.push("insert"); inserted.push(ps); return ps.map((p) => p.ref); },
    ...over,
  };
  return { d, log, inserted };
}

describe("handleWatch", () => {
  it("inserts only refs Supabase returned, with Supabase's names", async () => {
    const { d, inserted } = deps();
    const path = await handleWatch(T, C, [SHOP, "forgedforgedforgedfo"], d);
    expect(path).toBe(`/w/${T}/projects?added=1`);
    expect(inserted).toEqual([[{ ref: SHOP, name: "Shop" }]]);
  });

  it("never inserts a project Supabase reports as not running", async () => {
    const { d, log } = deps();
    expect(await handleWatch(T, C, [PAUSED], d)).toBe(`/w/${T}/projects?error=none`);
    expect(log).not.toContain("insert");
  });

  it("refuses a member before any token or Supabase call", async () => {
    const { d, log } = deps({ role: "member", list: async () => { throw new Error("must not list"); } });
    expect(await handleWatch(T, C, [SHOP], d)).toBe(`/w/${T}/projects?error=role`);
    expect(log).toEqual(["prepare"]);
  });

  it("refuses a connection outside the tenant", async () => {
    const { d, log } = deps({ prepare: async () => ({ role: "admin", token: null }) });
    expect(await handleWatch(T, C, [SHOP], d)).toBe(`/w/${T}/projects?error=connection`);
    expect(log).not.toContain("list");
  });

  it("refuses when the role was lost between the two transactions", async () => {
    const { d } = deps({ insert: async () => null });
    expect(await handleWatch(T, C, [SHOP], d)).toBe(`/w/${T}/projects?error=role`);
  });

  it("does nothing for an empty or malformed submission", async () => {
    const { d, log } = deps();
    expect(await handleWatch(T, C, [], d)).toBe(`/w/${T}/projects?error=none`);
    expect(await handleWatch(T, C, ["'; drop table x;--", 42, null], d)).toBe(`/w/${T}/projects?error=none`);
    expect(log).toEqual([]);
  });

  it.each([401, 403])("asks for a reconnect when Supabase answers %i", async (status) => {
    const { d, log } = deps({ list: async () => { throw new ManagementApiError("x", status); } });
    expect(await handleWatch(T, C, [SHOP], d)).toBe(`/w/${T}/projects?error=reconnect`);
    expect(log).not.toContain("insert");
  });

  it("asks for a reconnect when the token refresh fails", async () => {
    const { d } = deps({ prepare: async () => { throw new OAuthError("revoked", 400); } });
    expect(await handleWatch(T, C, [SHOP], d)).toBe(`/w/${T}/projects?error=reconnect`);
  });

  it("reports other Supabase failures without a reconnect", async () => {
    const { d } = deps({ list: async () => { throw new ManagementApiError("x", 502); } });
    expect(await handleWatch(T, C, [SHOP], d)).toBe(`/w/${T}/projects?error=supabase`);
    const { d: d2 } = deps({ list: async () => { throw new TypeError("network"); } });
    expect(await handleWatch(T, C, [SHOP], d2)).toBe(`/w/${T}/projects?error=supabase`);
  });

  it("rethrows unexpected errors from the transaction", async () => {
    const { d } = deps({ prepare: async () => { throw new Error("db down"); } });
    await expect(handleWatch(T, C, [SHOP], d)).rejects.toThrow("db down");
  });

  it("reports zero added when every pick is already watched", async () => {
    const { d } = deps({ insert: async () => [] });
    expect(await handleWatch(T, C, [SHOP, BLOG], d)).toBe(`/w/${T}/projects?added=0`);
  });
});

describe("submittedRefs", () => {
  it("keeps valid refs, removes duplicates, caps the count", () => {
    expect([...submittedRefs([SHOP, SHOP, "short", BLOG])]).toEqual([SHOP, BLOG]);
    const many = Array.from({ length: 150 }, (_, i) => `ref${String(i).padStart(17, "0")}`);
    expect(submittedRefs(many).size).toBe(MAX_PICK);
  });
});

describe("removalOutcome", () => {
  const shop = { name: "Shop", role: "admin" as const };
  const viewer = { name: "Shop", role: "viewer" as const };
  const editor = { name: "Shop", role: "editor" as const };
  const owned = { name: "Shop", role: "owner" as const };
  it("removes for workspace owners and admins, and for the project's Owner, who type the exact name", () => {
    expect(removalOutcome("owner", { name: "Shop", role: "owner" }, "Shop")).toBe("removed");
    expect(removalOutcome("admin", shop, "  Shop ")).toBe("removed");
    expect(removalOutcome("member", owned, "Shop")).toBe("removed");
  });
  it.each([
    ["member", shop, "Shop", "role"],
    ["member", editor, "Shop", "role"],
    ["member", viewer, "Shop", "role"],
    ["member", null, "Shop", "role"],
    ["owner", null, "Shop", "missing"],
    ["owner", shop, "shop", "mismatch"],
    ["owner", shop, "", "mismatch"],
    ["admin", shop, "Sho", "mismatch"],
  ] as const)("%s, %j, %j → %s", (role, p, typed, expected) => expect(removalOutcome(role, p, typed)).toBe(expected));
});

describe("keepOutcome (decision 042)", () => {
  const removal = { activeUntil: new Date(), deleteAfter: new Date() };
  it("keeps for the people who may remove, while a removal is scheduled", () => {
    expect(keepOutcome("owner", { role: "admin", removal })).toBe("kept");
    expect(keepOutcome("admin", { role: "admin", removal })).toBe("kept");
    expect(keepOutcome("member", { role: "owner", removal })).toBe("kept");
  });
  it.each([
    ["member", { role: "admin", removal }, "role"],
    ["member", { role: "editor", removal }, "role"],
    ["member", { role: "viewer", removal }, "role"],
    ["member", null, "role"],
    ["owner", null, "missing"],
    ["owner", { role: "admin", removal: null }, "missing"],
  ] as const)("%s, %j → %s", (role, p, expected) => expect(keepOutcome(role, p)).toBe(expected));
  it("sends the notices to the projects page", () => {
    const t = "00000000-0000-4000-8000-000000000001" as Parameters<typeof picksPath>[0];
    expect(picksPath(t, "kept")).toBe(`/w/${t}/projects?kept=1`);
    expect(picksPath(t, "removed")).toBe(`/w/${t}/projects?removed=1`);
  });
});
