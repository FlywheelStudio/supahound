import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as repo from "../../src/db/repo.js";
import * as sd from "../../src/db/scanDomains.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import { domainId, verifiedUserId, type DomainId, type ProjectId, type TenantId, type UserId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

// Scan domains per project (issue #100, decision 040): one project per verified domain, the
// owner/admin write rules, and RLS on the link and on the scan funnel tables it opens.

const SCAN_TABLES = ["scan_domains", "scan_authorizations", "scans", "scan_findings", "scan_jobs"] as const;
const user = () => verifiedUserId(randomUUID());

describe.skipIf(pgInfo === null)("scan domains per project", () => {
  const db = useDb();
  const u = { owner: user(), admin: user(), projAdmin: user(), editor: user(), viewer: user(), stranger: user(), other: user() };
  let A: TenantId;
  let B: TenantId;
  let p1: ProjectId;
  let p2: ProjectId;
  let pB: ProjectId;
  let shop: DomainId; // verified, two finished scans and a running one
  let blog: DomainId; // verified, no scans
  let pending: DomainId; // not verified
  let foreign: DomainId; // tenant B, verified

  const as = <T>(who: UserId, t: TenantId, fn: Parameters<typeof withTenantForUser<T>>[3]) => withTenantForUser(db.app, who, t, fn);
  const sys = <T>(t: TenantId, fn: Parameters<typeof withTenant<T>>[2]) => withTenant(db.app, t, fn);

  async function addProject(t: TenantId, name: string, ref: string): Promise<ProjectId> {
    return sys(t, async (tx) => {
      const conn = await repo.createConnection(tx, db.vault, { label: name, token: `token-${randomUUID()}` });
      return repo.createProject(tx, { connectionId: conn, supabaseRef: ref, name });
    });
  }

  async function addDomain(t: TenantId, apex: string, verified: boolean): Promise<DomainId> {
    const [row] = await sys(t, (tx) => tx.query<{ id: string }>(
      `INSERT INTO supahound.scan_domains (tenant_id, apex, verification_token, token_expires_at, verified_at)
       VALUES ($1, $2, $3, now() + interval '1 day', CASE WHEN $4 THEN now() END) RETURNING id`,
      [t, apex, "b".repeat(32), verified],
    ));
    await sys(t, (tx) => tx.query(
      "INSERT INTO supahound.scan_authorizations (tenant_id, domain_id, tos_version, email) VALUES ($1, $2, 'v1', $3)",
      [t, row!.id, `founder@${apex}`],
    ));
    return domainId(row!.id);
  }

  async function addScan(
    t: TenantId, domain: DomainId, status: "done" | "running", createdAt: string,
    findings: { severity: string; type: string; evidence?: object }[],
  ): Promise<string> {
    return sys(t, async (tx) => {
      const [scan] = await tx.query<{ id: string }>(
        `INSERT INTO supahound.scans (tenant_id, domain_id, mode, status, score, created_at, finished_at)
         VALUES ($1, $2, 'introductory', $3, 60, $4, CASE WHEN $3 = 'done' THEN $4::timestamptz END) RETURNING id`,
        [t, domain, status, createdAt],
      );
      for (const f of findings) {
        await tx.query(
          `INSERT INTO supahound.scan_findings (tenant_id, scan_id, severity, type, endpoint, evidence, fix)
           VALUES ($1, $2, $3, $4, 'https://shop.test/app.js', $5, 'Rotate the key.')`,
          [t, scan!.id, f.severity, f.type, JSON.stringify(f.evidence ?? {})],
        );
      }
      await tx.query("INSERT INTO supahound.scan_jobs (tenant_id, scan_id, state) VALUES ($1, $2, 'done')", [t, scan!.id]);
      return scan!.id;
    });
  }

  const insertLink = (who: UserId | null, t: TenantId, domain: string, project: string) => {
    const sql = "INSERT INTO supahound.scan_domain_links (tenant_id, domain_id, project_id) VALUES ($1, $2, $3)";
    return who ? as(who, t, (tx) => tx.query(sql, [t, domain, project])) : sys(t, (tx) => tx.query(sql, [t, domain, project]));
  };

  const seen = async (who: UserId, t: TenantId, table: string) => {
    const rows = await as(who, t, (tx) => tx.query<{ n: number }>(`SELECT count(*)::int AS n FROM supahound.${table}`));
    return rows[0]!.n;
  };

  beforeAll(async () => {
    A = await createWorkspace(db.app, u.owner, "Agency", "owner@agency.test");
    B = await createWorkspace(db.app, u.other, "Other", "owner@other.test");
    p1 = await addProject(A, "Shop", "aaaaaaaaaaaaaaaaaaaa");
    p2 = await addProject(A, "Blog", "bbbbbbbbbbbbbbbbbbbb");
    pB = await addProject(B, "Other app", "cccccccccccccccccccc");
    await sys(A, async (tx) => {
      for (const [who, role] of [[u.admin, "admin"], [u.projAdmin, "member"], [u.editor, "member"], [u.viewer, "member"], [u.stranger, "member"]] as const) {
        await tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, $3)", [A, who, role]);
      }
      for (const [who, role] of [[u.projAdmin, "admin"], [u.editor, "editor"], [u.viewer, "viewer"]] as const) {
        await tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, $4)", [A, p1, who, role]);
      }
    });
    shop = await addDomain(A, "shop-agency.com", true);
    blog = await addDomain(A, "blog-agency.com", true);
    pending = await addDomain(A, "pending-agency.com", false);
    foreign = await addDomain(B, "other.com", true);
    await addScan(A, shop, "done", "2026-11-10T10:00:00Z", [{ severity: "medium", type: "old-finding" }]);
    await addScan(A, shop, "done", "2026-11-11T10:00:00Z", [
      { severity: "low", type: "exposed-secret:low-rule" },
      { severity: "critical", type: "exposed-secret:supabase-service-role-key", evidence: { rule: "supabase-service-role-key", last4: "Wxyz" } },
      { severity: "info", type: "info-note" },
    ]);
    await addScan(A, shop, "running", "2026-11-12T10:00:00Z", []);
    await addScan(B, foreign, "done", "2026-11-11T10:00:00Z", [{ severity: "high", type: "b-finding" }]);
  });

  describe("linking", () => {
    it("lets a workspace owner list verified, unlinked domains and link one", async () => {
      const linkable = await as(u.owner, A, (tx) => sd.listLinkableDomains(tx));
      expect(linkable.map((d) => d.apex)).toEqual(["blog-agency.com", "shop-agency.com"]);
      expect(await as(u.owner, A, (tx) => sd.linkDomain(tx, p1, shop, u.owner))).toBe("linked");
      const linked = await as(u.owner, A, (tx) => sd.listProjectDomains(tx, p1));
      expect(linked.map((d) => d.apex)).toEqual(["shop-agency.com"]);
      expect((await as(u.owner, A, (tx) => sd.listLinkableDomains(tx))).map((d) => d.apex)).toEqual(["blog-agency.com"]);
      const [row] = await db.admin.query("SELECT linked_by FROM supahound.scan_domain_links WHERE domain_id = $1", [shop]).then((r) => r.rows);
      expect(row.linked_by).toBe(u.owner);
    });

    it("links a domain to one project at most", async () => {
      expect(await as(u.owner, A, (tx) => sd.linkDomain(tx, p1, shop, u.owner))).toBe("already");
      expect(await as(u.owner, A, (tx) => sd.linkDomain(tx, p2, shop, u.owner))).toBe("taken");
      // Without the app's ON CONFLICT, the primary key refuses a second link even for the poller.
      await expect(insertLink(null, A, shop, p2)).rejects.toThrow(/duplicate key/);
      const links = await db.admin.query("SELECT project_id FROM supahound.scan_domain_links WHERE domain_id = $1", [shop]);
      expect(links.rows.map((r) => r.project_id)).toEqual([p1]);
    });

    it("refuses an unverified domain, for signed-in users and for the poller alike", async () => {
      expect(await as(u.owner, A, (tx) => sd.linkDomain(tx, p2, pending, u.owner))).toBe("unverified");
      await expect(insertLink(u.owner, A, pending, p2)).rejects.toThrow(/not verified/);
      await expect(insertLink(null, A, pending, p2)).rejects.toThrow(/not verified/);
    });

    it("never links across tenants", async () => {
      // Another tenant's domain is invisible, so it counts as unverified; its project fails the foreign key.
      expect(await as(u.owner, A, (tx) => sd.linkDomain(tx, p1, foreign, u.owner))).toBe("unverified");
      await expect(insertLink(null, A, foreign, p1)).rejects.toThrow(/not verified/);
      await expect(insertLink(null, A, blog, pB)).rejects.toThrow(/foreign key/);
      await expect(insertLink(null, B, foreign, p1)).rejects.toThrow(/foreign key/);
    });

    it("refuses editors and viewers in RLS, and lets a project admin past it", async () => {
      // shop is visible to them (linked to p1), so the trigger passes and RLS decides.
      for (const who of [u.editor, u.viewer]) {
        await expect(insertLink(who, A, shop, p1), who).rejects.toThrow(/row-level security/);
      }
      // A project admin passes RLS; the primary key then refuses the second link.
      await expect(insertLink(u.projAdmin, A, shop, p1)).rejects.toThrow(/duplicate key/);
    });

    it("shows unlinked domains to workspace owners and admins only (decision 040)", async () => {
      expect((await as(u.admin, A, (tx) => sd.listLinkableDomains(tx))).map((d) => d.apex)).toEqual(["blog-agency.com"]);
      for (const who of [u.projAdmin, u.editor, u.viewer, u.stranger]) {
        expect(await as(who, A, (tx) => sd.listLinkableDomains(tx)), who).toEqual([]);
      }
      // So a project admin who is not a workspace admin cannot attach a workspace domain.
      expect(await as(u.projAdmin, A, (tx) => sd.linkDomain(tx, p1, blog, u.projAdmin))).toBe("unverified");
    });
  });

  describe("reading (RLS)", () => {
    it("shows the project's people its domain and every scan row of it, and nothing else", async () => {
      for (const who of [u.projAdmin, u.editor, u.viewer]) {
        expect((await as(who, A, (tx) => sd.listProjectDomains(tx, p1))).map((d) => d.id), who).toEqual([shop]);
        const domains = await as(who, A, (tx) => tx.query<{ id: string }>("SELECT id FROM supahound.scan_domains"));
        expect(domains.map((r) => r.id)).toEqual([shop]);
        expect(await seen(who, A, "scans")).toBe(3);
        expect(await seen(who, A, "scan_findings")).toBe(4);
        expect(await seen(who, A, "scan_jobs")).toBe(3);
        expect(await seen(who, A, "scan_authorizations")).toBe(1);
      }
    });

    it("shows a workspace member with no project role no link and no scan row", async () => {
      expect(await seen(u.stranger, A, "scan_domain_links")).toBe(0);
      for (const table of SCAN_TABLES) expect(await seen(u.stranger, A, table), table).toBe(0);
      expect(await as(u.stranger, A, (tx) => sd.projectScanResults(tx, p1))).toEqual([]);
    });

    it("shows workspace owners and admins every domain, and the poller the whole tenant", async () => {
      for (const who of [u.owner, u.admin]) {
        expect(await seen(who, A, "scan_domains"), who).toBe(3);
        expect(await seen(who, A, "scan_findings"), who).toBe(4);
      }
      const all = await sys(A, (tx) => tx.query("SELECT 1 FROM supahound.scan_domains"));
      expect(all).toHaveLength(3);
    });

    it("never shows another tenant's links or scans", async () => {
      await sys(B, (tx) => sd.linkDomain(tx, pB, foreign, null));
      expect(await seen(u.owner, A, "scan_domain_links")).toBe(1);
      expect(await as(u.owner, A, (tx) => sd.projectScanResults(tx, pB))).toEqual([]);
      expect(await seen(u.other, B, "scan_domain_links")).toBe(1);
      expect(await as(u.other, B, (tx) => sd.projectScanResults(tx, p1))).toEqual([]);
      expect(await seen(u.other, B, "scan_findings")).toBe(1);
    });

    it("lists the latest finished scan's findings, most severe first, and a newer scan that has not finished", async () => {
      const [r] = await as(u.viewer, A, (tx) => sd.projectScanResults(tx, p1));
      expect(r!.apex).toBe("shop-agency.com");
      expect(r!.newer).toBe("running");
      expect(r!.latest!.finishedAt).toEqual(new Date("2026-11-11T10:00:00Z"));
      expect(r!.latest!.findings.map((f) => f.severity)).toEqual(["critical", "low", "info"]);
      expect(r!.latest!.findings[0]!.evidence).toEqual({ rule: "supabase-service-role-key", last4: "Wxyz" });
      expect(r!.latest!.findings[0]!.fix).toBe("Rotate the key.");
    });

    it("lists a linked domain with no finished scan as such", async () => {
      expect(await as(u.owner, A, (tx) => sd.linkDomain(tx, p2, blog, u.owner))).toBe("linked");
      const [r] = await as(u.owner, A, (tx) => sd.projectScanResults(tx, p2));
      expect([r!.apex, r!.latest, r!.newer]).toEqual(["blog-agency.com", null, null]);
      // p2's link is invisible to p1's people.
      expect(await seen(u.viewer, A, "scan_domain_links")).toBe(1);
      expect(await as(u.viewer, A, (tx) => sd.projectScanResults(tx, p2))).toEqual([]);
    });
  });

  describe("detaching", () => {
    it("refuses editors and viewers, and lets a project admin detach", async () => {
      for (const who of [u.editor, u.viewer, u.stranger]) {
        expect(await as(who, A, (tx) => sd.unlinkDomain(tx, p1, shop)), who).toBe(false);
      }
      expect(await as(u.projAdmin, A, (tx) => sd.unlinkDomain(tx, p1, shop))).toBe(true);
      expect(await as(u.projAdmin, A, (tx) => sd.unlinkDomain(tx, p1, shop))).toBe(false);
      // The domain is unlinked again: p1's people no longer see it or its scans.
      expect(await seen(u.viewer, A, "scan_domains")).toBe(0);
      expect(await seen(u.viewer, A, "scan_findings")).toBe(0);
    });

    it("drops the link, not the domain, when the project is removed", async () => {
      await sys(A, (tx) => tx.query("DELETE FROM supahound.projects WHERE id = $1", [p2]));
      const links = await db.admin.query("SELECT 1 FROM supahound.scan_domain_links WHERE domain_id = $1", [blog]);
      const domains = await db.admin.query("SELECT 1 FROM supahound.scan_domains WHERE id = $1", [blog]);
      expect([links.rowCount, domains.rowCount]).toEqual([0, 1]);
    });

    it("grants the app no UPDATE on links: a move is detach, then attach", async () => {
      await expect(sys(A, (tx) => tx.query("UPDATE supahound.scan_domain_links SET project_id = project_id"))).rejects.toThrow(/permission denied/);
    });
  });
});
