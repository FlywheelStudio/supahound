import { PROJECT_ROLES, type ProjectRole } from "@supahound/core/db/people";
import { projectId, tenantId } from "@supahound/core/tenancy/scope";
import { describe, expect, it } from "vitest";
import { renderInviteEmail } from "../lib/email/invite";
import {
  assignableRoles, can, canGrant, canManagePerson, canRemoveProject, handleInvite, invitePagePath, inviteUrl, noticeFrom,
  parseInviteEmail, parseRole, parseUuid, peoplePath, type InviteDeps,
} from "../lib/people";
import { safeNext } from "../lib/security";

const T = tenantId("aaaaaaaa-0000-4000-8000-000000000001");
const P = projectId("bbbbbbbb-0000-4000-8000-000000000002");
const PEOPLE = `/w/${T}/p/${P}/settings/people`;
const ME = "cccccccc-0000-4000-8000-000000000003";
const THEM = "dddddddd-0000-4000-8000-000000000004";

describe("the role matrix (decision 036)", () => {
  it.each([
    ["owner", [true, true, true, true]],
    ["admin", [true, true, true, false]],
    ["editor", [true, true, false, false]],
    ["viewer", [true, false, false, false]],
    [null, [false, false, false, false]],
  ] as const)("%s: view, edit settings, manage people, manage owners", (role, want) => {
    expect((["view", "edit_settings", "manage_people", "manage_owners"] as const).map((a) => can(role, a))).toEqual(want);
  });

  it("lets the project's Owner and workspace owners and admins remove a project", () => {
    expect(canRemoveProject("owner", "member")).toBe(true);
    expect(canRemoveProject("admin", "admin")).toBe(true);
    expect(canRemoveProject("owner", "owner")).toBe(true);
    for (const r of ["admin", "editor", "viewer", null] as const) expect(canRemoveProject(r, "member"), String(r)).toBe(false);
  });

  it("lets an Owner grant any role and an Admin any role but Owner", () => {
    expect(assignableRoles("owner")).toEqual([...PROJECT_ROLES]);
    expect(assignableRoles("admin")).toEqual(["admin", "editor", "viewer"]);
    expect(assignableRoles("editor")).toEqual([]);
    expect(assignableRoles("viewer")).toEqual([]);
    expect(assignableRoles(null)).toEqual([]);
    expect(canGrant("admin", "owner")).toBe(false);
    expect(canGrant("owner", "owner")).toBe(true);
  });

  it("never lets anyone manage themselves or a workspace owner or admin; only an Owner manages an Owner", () => {
    const person = (role: ProjectRole, source: "workspace" | "project" = "project", userId = THEM) => ({ userId, role, source });
    expect(canManagePerson("owner", ME, person("owner"))).toBe(true);
    expect(canManagePerson("admin", ME, person("owner"))).toBe(false);
    expect(canManagePerson("admin", ME, person("admin"))).toBe(true);
    expect(canManagePerson("admin", ME, person("viewer"))).toBe(true);
    expect(canManagePerson("owner", ME, person("admin", "workspace"))).toBe(false);
    expect(canManagePerson("owner", ME, person("viewer", "project", ME))).toBe(false);
    expect(canManagePerson("editor", ME, person("viewer"))).toBe(false);
    expect(canManagePerson("viewer", ME, person("viewer"))).toBe(false);
  });
});

describe("form parsing", () => {
  it("normalizes a valid address and refuses anything else", () => {
    expect(parseInviteEmail("  Ana@Example.COM ")).toBe("ana@example.com");
    for (const bad of ["", "ana", "ana@", "@x.com", "a b@x.com", "ana@x", "a@b\r\nBcc: c@d", null, 42, `${"a".repeat(320)}@x.com`]) {
      expect(parseInviteEmail(bad), String(bad)).toBeNull();
    }
  });

  it("accepts only the four roles and lower-case UUIDs", () => {
    expect(parseRole("editor")).toBe("editor");
    for (const bad of ["Editor", "member", "superuser", "", null]) expect(parseRole(bad)).toBeNull();
    expect(parseUuid(THEM.toUpperCase())).toBe(THEM);
    expect(parseUuid("' OR 1=1")).toBeNull();
  });
});

describe("paths", () => {
  it("builds the accept link on our own origin, with the token as a query value", () => {
    expect(inviteUrl("https://app.example", `${T}.abc_-`)).toBe(`https://app.example/invite?token=${T}.abc_-`);
    expect(invitePagePath("t.x", "expired")).toBe("/invite?token=t.x&error=expired");
    expect(safeNext(invitePagePath("t.x"))).toBe("/invite?token=t.x");
  });

  it("maps notices to the People page and back", () => {
    expect(peoplePath(T, P, "invited")).toBe(`${PEOPLE}?done=invited`);
    expect(peoplePath(T, P, "role")).toBe(`${PEOPLE}?error=role`);
    expect(noticeFrom({ done: "invited" })?.tone).toBe("ok");
    expect(noticeFrom({ error: "role" })?.tone).toBe("error");
    expect(noticeFrom({ error: "<script>" })).toBeNull();
  });
});

describe("handleInvite", () => {
  function deps(actor: ProjectRole | null, result: "created" | "renewed" | "member" | "invalid" = "created", sendFails = false) {
    const saved: string[] = [];
    const sent: string[] = [];
    const d: InviteDeps = {
      token: () => "tok",
      save: async (email, role) => {
        if (!canGrant(actor, role)) return { actor, result: null };
        saved.push(`${email}:${role}`);
        return { actor, result };
      },
      send: async (email, token) => {
        if (sendFails) throw new Error("smtp down");
        sent.push(`${email}:${token}`);
      },
    };
    return { d, saved, sent };
  }

  it("saves, then emails, for an owner or admin", async () => {
    for (const actor of ["owner", "admin"] as const) {
      const x = deps(actor);
      expect(await handleInvite(T, P, " Ana@Example.com", "editor", x.d)).toBe(`${PEOPLE}?done=invited`);
      expect(x.saved).toEqual(["ana@example.com:editor"]);
      expect(x.sent).toEqual(["ana@example.com:tok"]);
    }
  });

  it("refuses editors, viewers and an admin inviting an Owner; nothing is saved or sent", async () => {
    for (const [actor, role] of [["editor", "viewer"], ["viewer", "viewer"], ["admin", "owner"], [null, "viewer"]] as const) {
      const x = deps(actor);
      expect(await handleInvite(T, P, "ana@example.com", role, x.d)).toBe(`${PEOPLE}?error=role`);
      expect([x.saved, x.sent]).toEqual([[], []]);
    }
  });

  it("checks the form before any database call", async () => {
    const x = deps("owner");
    expect(await handleInvite(T, P, "nope", "viewer", x.d)).toBe(`${PEOPLE}?error=email`);
    expect(await handleInvite(T, P, "ana@example.com", "root", x.d)).toBe(`${PEOPLE}?error=role`);
    expect(x.saved).toEqual([]);
  });

  it("says when the person is already on the project, and sends nothing", async () => {
    const x = deps("owner", "member");
    expect(await handleInvite(T, P, "ana@example.com", "viewer", x.d)).toBe(`${PEOPLE}?error=member`);
    expect(x.sent).toEqual([]);
  });

  it("reports a renewal, and a failed send without losing the saved invite", async () => {
    expect(await handleInvite(T, P, "ana@example.com", "viewer", deps("owner", "renewed").d)).toBe(`${PEOPLE}?done=renewed`);
    const x = deps("owner", "created", true);
    expect(await handleInvite(T, P, "ana@example.com", "viewer", x.d)).toBe(`${PEOPLE}?error=send_failed`);
    expect(x.saved).toHaveLength(1);
  });
});

describe("the invite email", () => {
  const base = { role: "editor" as const, inviterEmail: "boss@example.com", link: "https://app.example/invite?token=t", expiresInDays: 7 };

  it("names the project, the role, the inviter and the expiry, with our link only", () => {
    const e = renderInviteEmail({ ...base, projectName: "Shop" });
    expect(e.subject).toBe("Join Shop on Supahound");
    expect(e.text).toContain("boss@example.com invited you to the project Shop on Supahound, as Editor.");
    expect(e.text).toContain("https://app.example/invite?token=t");
    expect(e.text).toContain("expires in 7 days");
    expect(e.html.match(/href="/g)).toHaveLength(1);
  });

  it("escapes HTML and strips line breaks from the project name", () => {
    const e = renderInviteEmail({ ...base, projectName: '<img src=x onerror="alert(1)">\r\nBcc: x@y' });
    expect(e.html).not.toContain("<img");
    expect(e.html).toContain("&lt;img");
    expect(e.subject).not.toMatch(/[\r\n]/);
    expect(e.text.split("\n")[0]).not.toMatch(/\r/);
  });

  it("caps a very long project name", () => {
    const e = renderInviteEmail({ ...base, projectName: "x".repeat(500), inviterEmail: null });
    expect(e.subject.length).toBeLessThanOrEqual(160);
    expect(e.text).toMatch(/^You are invited to the project x+…/);
  });
});
