import { randomUUID } from "node:crypto";
import { beforeEach, describe, expect, it } from "vitest";
import type { Severity } from "../../src/detectors/finding.js";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import { templateExplanation } from "../../src/explainer/template.js";
import { ownershipFromColumns } from "../../src/ownership/ownership.js";
import { pollProject, sendPendingAlerts, type OutgoingEmail, type PollDeps } from "../../src/poller/pollProject.js";
import { projectId, projectScope, tenantId, verifiedUserId as userId, type ProjectScope } from "../../src/tenancy/scope.js";
import { ALICE, BOB } from "../helpers.js";
import { pgInfo, useDb } from "./harness.js";

// Incident alert email (issue #16, decision 030): the incident row is the outbox.

const NOW = new Date("2026-11-11T12:30:00Z");
const attackRows = [
  {
    method: "GET", path: "/rest/v1/notes", search: `?user_id=eq.${BOB}`, status: "200", contentRange: "0-49/*",
    userAgent: "python-httpx/0.28.1", asn: "14061", asOrganization: "DigitalOcean, LLC",
    jwtSubject: ALICE, jwtRole: "authenticated", apiKeyRole: "anon", hits: "37",
    first_seen: "2026-11-11T12:27:00Z", last_seen: "2026-11-11T12:28:00Z",
  },
];

// Workspace owners get every project's alerts, so any project ID will do for owner-only checks.
const ANY_PROJECT = projectId(randomUUID());

describe.skipIf(pgInfo === null)("incident alert email", () => {
  const db = useDb();
  let scope: ProjectScope;
  let other: ProjectScope;
  let sent: OutgoingEmail[];
  let failFor: Set<string>;

  async function onboard(name: string, members: string[]): Promise<ProjectScope> {
    const t = tenantId(randomUUID());
    const s = await withTenant(db.app, t, async (tx) => {
      await repo.createTenant(tx, name);
      const conn = await repo.createConnection(tx, db.vault, { label: name, token: `token-${randomUUID()}` });
      const p = await repo.createProject(tx, { connectionId: conn, supabaseRef: "abcdefghijklmnopqrst", name });
      await repo.setOwnership(tx, p, ownershipFromColumns({ notes: ["user_id"] }));
      // Members with a role on this project (decision 036): the people its alerts go to.
      for (const email of members) {
        const u = randomUUID();
        await tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role, email) VALUES ($1, $2, 'member', $3)", [t, u, email]);
        await tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'viewer')", [t, p, u]);
      }
      return projectScope(t, p);
    });
    return s;
  }

  async function openIncident(s: ProjectScope, severity: Severity, alerted: Severity | null = null): Promise<string> {
    return withTenant(db.app, s.tenantId, async (tx) => {
      const id = await repo.upsertIncident(tx, s.projectId, {
        id: null, actor: randomUUID(), status: "open", severity, detectors: ["cross_tenant"], signals: ["other_owner"],
        findingCount: 1, hits: 5, openedAt: NOW, lastSeenAt: NOW,
      });
      if (alerted) await repo.markAlerted(tx, id, alerted);
      return id;
    });
  }

  const setLevel = (s: ProjectScope, level: Parameters<typeof repo.setEmailAlerts>[2]) =>
    withTenant(db.app, s.tenantId, (tx) => repo.setEmailAlerts(tx, s.projectId, level));
  const pending = (s: ProjectScope) => withTenant(db.app, s.tenantId, (tx) => repo.pendingAlerts(tx, s.projectId));
  const audits = (s: ProjectScope) =>
    withTenant(db.app, s.tenantId, (tx) =>
      tx.query<{ detail: Record<string, unknown> }>("SELECT detail FROM supahound.audit_log WHERE action = 'alert_email' ORDER BY created_at"),
    );

  function deps(over: Partial<PollDeps> = {}): PollDeps {
    return {
      app: db.app,
      vault: db.vault,
      now: () => NOW,
      queryLogs: async () => attackRows,
      queryPolicies: async () => { throw new Error("ownership was hand-set"); },
      explain: async (f) => ({ explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] }),
      alerts: {
        from: { email: "alerts@supahound.test", name: "Supahound alerts" },
        appUrl: "https://app.supahound.test",
        send: async (m) => {
          if (failFor.has(m.to)) throw new Error("send failed");
          sent.push(m);
        },
      },
      ...over,
    };
  }

  beforeEach(async () => {
    sent = [];
    failFor = new Set();
    scope = await onboard("Acme", ["a@acme.test", "B@acme.test"]);
    other = await onboard("Globex", ["x@globex.test"]);
  });

  it("emails every member once, one email each, from a full poll", async () => {
    const r = await pollProject(scope, deps());
    expect(r).toMatchObject({ status: "ok", emailed: 1 });
    expect(sent.map((m) => m.to).sort()).toEqual(["a@acme.test", "b@acme.test"]);
    expect(sent[0]!.subject).toMatch(/^\[(High|Critical)\] Cross-tenant data access on Acme$/);
    expect(sent[0]!.html).toContain("Suggested remediation");
    expect(sent[0]!.html).toContain(`https://app.supahound.test/w/${scope.tenantId}`);
    expect(sent.every((m) => m.from.email === "alerts@supahound.test")).toBe(true);
    expect(await pending(scope)).toEqual([]);
  });

  it("does not email again for a repeat of an open incident (UAT-D4)", async () => {
    await pollProject(scope, deps());
    sent = [];
    await pollProject(scope, deps({ now: () => new Date(NOW.getTime() + 60_000) }));
    expect(sent).toEqual([]);
  });

  it("never sends one tenant's alert to another tenant's members", async () => {
    await pollProject(scope, deps());
    await openIncident(other, "low");
    await sendPendingAlerts(other, deps());
    const byTo = (to: string) => sent.filter((m) => m.to === to);
    expect(byTo("x@globex.test")).toHaveLength(1);
    expect(byTo("x@globex.test")[0]!.subject).toContain("Globex");
    expect(sent.filter((m) => m.subject.includes("Globex")).map((m) => m.to)).toEqual(["x@globex.test"]);
  });

  it("emails every severity by default and respects the project's threshold", async () => {
    await openIncident(scope, "low");
    expect((await pending(scope)).map((p) => p.severity)).toEqual(["low"]);

    await setLevel(scope, "high");
    expect(await pending(scope)).toEqual([]);
    expect(await sendPendingAlerts(scope, deps())).toBe(0);
    expect(sent).toEqual([]);

    await setLevel(scope, "off");
    await openIncident(scope, "critical");
    expect(await pending(scope)).toEqual([]);
  });

  it("emails again when an incident escalates, and never lowers what was recorded", async () => {
    const id = await openIncident(scope, "high", "medium");
    const [p] = await pending(scope);
    expect(p).toMatchObject({ id, severity: "high", alertedSeverity: "medium" });
    await sendPendingAlerts(scope, deps());
    expect(sent[0]!.subject).toContain("escalated");
    expect(sent[0]!.text).toContain("Severity rose from Medium to High.");

    await withTenant(db.app, scope.tenantId, (tx) => repo.markAlerted(tx, id, "low"));
    const row = await withTenant(db.app, scope.tenantId, (tx) =>
      tx.query<{ alerted_severity: string }>("SELECT alerted_severity FROM supahound.incidents WHERE id = $1", [id]),
    );
    expect(row[0]!.alerted_severity).toBe("high");
  });

  it("keeps an alert pending when every send fails, and retries it", async () => {
    failFor = new Set(["a@acme.test", "b@acme.test"]);
    await openIncident(scope, "high");
    expect(await sendPendingAlerts(scope, deps())).toBe(0);
    expect(await pending(scope)).toHaveLength(1);

    failFor = new Set();
    expect(await sendPendingAlerts(scope, deps())).toBe(1);
    expect(await pending(scope)).toEqual([]);
    expect((await audits(scope)).map((a) => a.detail.outcome)).toEqual(["failed", "sent"]);
  });

  it("audits counts only, never addresses", async () => {
    failFor = new Set(["b@acme.test"]);
    await openIncident(scope, "medium");
    await sendPendingAlerts(scope, deps());
    const [a] = await audits(scope);
    expect(a!.detail).toMatchObject({ severity: "medium", recipients: 2, sent: 1, failed: 1, outcome: "partial", escalated: false });
    expect(JSON.stringify(a!.detail)).not.toContain("@");
  });

  it("marks an alert done when the workspace has no addresses, so it never emails late", async () => {
    await withTenant(db.app, scope.tenantId, (tx) => tx.query("UPDATE supahound.memberships SET email = NULL WHERE tenant_id = $1", [scope.tenantId]));
    await openIncident(scope, "high");
    await sendPendingAlerts(scope, deps());
    expect(sent).toEqual([]);
    expect(await pending(scope)).toEqual([]);
    expect((await audits(scope))[0]!.detail.outcome).toBe("no_recipients");
  });

  it("calls the model once per severity, even while an alert keeps failing to send", async () => {
    failFor = new Set(["a@acme.test", "b@acme.test"]);
    let calls = 0;
    const counting = deps({
      explain: async (f) => {
        calls += 1;
        return { explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] };
      },
    });
    await pollProject(scope, counting);
    await pollProject(scope, { ...counting, now: () => new Date(NOW.getTime() + 60_000) });
    await pollProject(scope, { ...counting, now: () => new Date(NOW.getTime() + 120_000) });
    expect(calls).toBe(1);
    expect(await pending(scope)).toHaveLength(1);
    failFor = new Set();
    await sendPendingAlerts(scope, counting);
    expect(sent[0]!.html).toContain("Suggested remediation");
    expect(calls).toBe(1);
  });

  it("sends nothing without alert deps, and the alert stays pending", async () => {
    await openIncident(scope, "high");
    expect(await sendPendingAlerts(scope, deps({ alerts: null }))).toBe(0);
    expect(await pending(scope)).toHaveLength(1);
  });

  describe("member addresses", () => {
    it("records the owner's address at workspace creation", async () => {
      const user = userId(randomUUID());
      const t = await createWorkspace(db.app, user, "Initech", "owner@initech.test");
      const rows = await withTenant(db.app, t, (tx) => repo.alertRecipients(tx, ANY_PROJECT));
      expect(rows).toEqual(["owner@initech.test"]);
    });

    it("updates a member's own address inside the tenant, and only when it changed", async () => {
      const user = userId(randomUUID());
      const t = await createWorkspace(db.app, user, "Initech", null);
      expect(await withTenantForUser(db.app, user, t, (tx) => repo.recordMemberEmail(tx, user, "new@initech.test"))).toBe(true);
      expect(await withTenantForUser(db.app, user, t, (tx) => repo.recordMemberEmail(tx, user, "new@initech.test"))).toBe(false);
      expect(await withTenantForUser(db.app, user, t, (tx) => repo.recordMemberEmail(tx, user, "not an email"))).toBe(false);
      expect(await withTenantForUser(db.app, user, t, (tx) => repo.recordMemberEmail(tx, user, "a@b\r\nBcc: c@d"))).toBe(false);
      expect(await withTenant(db.app, t, (tx) => repo.alertRecipients(tx, ANY_PROJECT))).toEqual(["new@initech.test"]);
    });

    it("cannot write another tenant's membership", async () => {
      const user = userId(randomUUID());
      const t = await createWorkspace(db.app, user, "Initech", "owner@initech.test");
      // Same user ID, wrong tenant: RLS hides the row, so nothing changes.
      const wrote = await withTenant(db.app, other.tenantId, (tx) => repo.recordMemberEmail(tx, user, "evil@x.test"));
      expect(wrote).toBe(false);
      expect(await withTenant(db.app, t, (tx) => repo.alertRecipients(tx, ANY_PROJECT))).toEqual(["owner@initech.test"]);
    });

    it("rejects malformed addresses in the database too", async () => {
      await expect(
        withTenant(db.app, scope.tenantId, (tx) => tx.query("UPDATE supahound.memberships SET email = 'a b@c' WHERE tenant_id = $1", [scope.tenantId])),
      ).rejects.toThrow(/check constraint/);
    });
  });

  it("cannot set another tenant's project threshold", async () => {
    const changed = await withTenant(db.app, other.tenantId, (tx) => repo.setEmailAlerts(tx, scope.projectId, "off"));
    expect(changed).toBe(false);
    const project = await withTenant(db.app, scope.tenantId, (tx) => repo.getProject(tx, scope.projectId));
    expect(project!.emailAlerts).toBe("low");
  });
});
