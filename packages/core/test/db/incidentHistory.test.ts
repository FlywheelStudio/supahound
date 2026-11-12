import { randomUUID } from "node:crypto";
import { beforeAll, describe, expect, it } from "vitest";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { createWorkspace, withTenantForUser } from "../../src/db/user.js";
import { verifiedUserId, type ProjectId, type TenantId } from "../../src/tenancy/scope.js";
import { pgInfo, useDb } from "./harness.js";

// Incident history (issue #44, decision 035): the 30-day window, keyset pagination and isolation
// between projects and tenants.

const NOW = new Date("2026-11-12T12:00:00Z");
const DAY = 86_400_000;

describe.skipIf(pgInfo === null)("Incident history (issue #44)", () => {
  const db = useDb();
  const alice = verifiedUserId(randomUUID());
  const bob = verifiedUserId(randomUUID());
  let a: TenantId;
  let b: TenantId;
  let shop: ProjectId;
  let blog: ProjectId;
  let bobs: ProjectId;

  // Inserts as the superuser, so tests can set exact timestamps (with microseconds) and status.
  async function insert(
    tenant: TenantId, project: ProjectId,
    row: { lastSeen: string; status?: "open" | "resolved"; id?: string; actor?: string; summary?: object | null },
  ): Promise<string> {
    const id = row.id ?? randomUUID();
    await db.admin.query(
      `INSERT INTO supahound.incidents
         (id, tenant_id, project_id, actor, status, severity, detectors, signals, finding_count, hits, opened_at, last_seen_at, summary, summary_source)
       VALUES ($1, $2, $3, $4, $5, 'high', '{cross_tenant}', '{other_owner}', 2, 9, $6::timestamptz - interval '5 minutes', $6::timestamptz, $7, $8)`,
      [id, tenant, project, row.actor ?? `user:${randomUUID()}`, row.status ?? "resolved", row.lastSeen,
        row.summary ? JSON.stringify(row.summary) : null, row.summary ? "template" : null],
    );
    return id;
  }

  const ago = (days: number, extraMs = 0) => new Date(NOW.getTime() - days * DAY - extraMs).toISOString();

  async function allPages(project: ProjectId, limit: number): Promise<{ ids: string[]; pages: number }> {
    const ids: string[] = [];
    let after: repo.IncidentCursor | null = null;
    let pages = 0;
    do {
      const page: Awaited<ReturnType<typeof repo.listIncidentHistory>> = await withTenantForUser(db.app, alice, a, (tx) =>
        repo.listIncidentHistory(tx, project, { now: NOW, limit, after }));
      ids.push(...page.incidents.map((i) => i.id));
      after = page.next;
      pages += 1;
      if (pages > 50) throw new Error("pagination does not end");
    } while (after);
    return { ids, pages };
  }

  beforeAll(async () => {
    a = await createWorkspace(db.app, alice, "Alice Co");
    b = await createWorkspace(db.app, bob, "Bob Co");
    const make = async (t: TenantId, ref: string, name: string) => withTenant(db.app, t, async (tx) => {
      const conn = await repo.createConnection(tx, db.vault, { label: "Supabase", token: "tok" });
      return repo.createProject(tx, { connectionId: conn, supabaseRef: ref, name });
    });
    shop = await make(a, "historyrefshopaaaaa1", "Shop");
    blog = await make(a, "historyrefblogaaaaa2", "Blog");
    bobs = await make(b, "historyrefbobbbbbbb3", "Bob shop");
  });

  it("lists open and resolved incidents newest first, inside the 30-day window", async () => {
    const recentOpen = await insert(a, shop, { lastSeen: ago(0, 60_000), status: "open" });
    const resolved = await insert(a, shop, { lastSeen: ago(3) });
    const boundary = await insert(a, shop, { lastSeen: ago(30) });
    const staleOpen = await insert(a, shop, { lastSeen: ago(40), status: "open" });
    const tooOld = await insert(a, shop, { lastSeen: ago(30, 1) });

    const page = await withTenantForUser(db.app, alice, a, (tx) => repo.listIncidentHistory(tx, shop, { now: NOW, limit: 25 }));
    expect(page.incidents.map((i) => i.id)).toEqual([recentOpen, resolved, boundary, staleOpen]);
    expect(page.incidents.map((i) => i.status)).toEqual(["open", "resolved", "resolved", "open"]);
    expect(page.next).toBeNull();

    // The detail follows the same window: the stale open incident opens, the old resolved one does not.
    const get = (id: string) => withTenantForUser(db.app, alice, a, (tx) => repo.getIncident(tx, shop, id, NOW));
    expect((await get(staleOpen))?.status).toBe("open");
    expect((await get(boundary))?.id).toBe(boundary);
    expect(await get(tooOld)).toBeNull();
  });

  it("returns the stored summary and its source, or null when the incident has none", async () => {
    const explained = await insert(a, shop, {
      lastSeen: ago(1), summary: { summary: "A user read `notes`.", likelyImpact: "Data may be exposed.", nextSteps: ["Fix `notes`."] },
    });
    const bare = await insert(a, shop, { lastSeen: ago(1, 1000), summary: null });
    const get = (id: string) => withTenantForUser(db.app, alice, a, (tx) => repo.getIncident(tx, shop, id, NOW));
    const e = await get(explained);
    expect(e).toMatchObject({ summarySource: "template", findingCount: 2, hits: 9, detectors: ["cross_tenant"], signals: ["other_owner"] });
    expect(e?.summary).toEqual({ summary: "A user read `notes`.", likelyImpact: "Data may be exposed.", nextSteps: ["Fix `notes`."] });
    expect(e!.lastSeenAt.getTime() - e!.openedAt.getTime()).toBe(5 * 60_000);
    expect(await get(bare)).toMatchObject({ summary: null, summarySource: null });
  });

  it("pages with a keyset cursor: no duplicates, no gaps, ties broken by id", async () => {
    // Blog: 7 incidents. Three share one timestamp; two differ only in the microseconds.
    const tie = ago(2);
    const tied = [randomUUID(), randomUUID(), randomUUID()];
    for (const id of tied) await insert(a, blog, { lastSeen: tie, id });
    const microA = await insert(a, blog, { lastSeen: "2026-11-11T08:00:00.123456Z" });
    const microB = await insert(a, blog, { lastSeen: "2026-11-11T08:00:00.123401Z" });
    const newest = await insert(a, blog, { lastSeen: ago(0, 1000) });
    const oldest = await insert(a, blog, { lastSeen: ago(20) });

    const expected = [newest, microA, microB, ...[...tied].sort().reverse(), oldest];
    const first = await withTenantForUser(db.app, alice, a, (tx) => repo.listIncidentHistory(tx, blog, { now: NOW, limit: 25 }));
    expect(first.incidents.map((i) => i.id)).toEqual(expected);

    for (const limit of [1, 2, 3, 6]) {
      const { ids, pages } = await allPages(blog, limit);
      expect(ids, `limit ${limit}`).toEqual(expected);
      expect(pages, `limit ${limit}`).toBe(Math.ceil(expected.length / limit));
    }
  });

  it("gives no next page when the last page is exactly full", async () => {
    const page = await withTenantForUser(db.app, alice, a, (tx) => repo.listIncidentHistory(tx, blog, { now: NOW, limit: 7 }));
    expect(page.incidents).toHaveLength(7);
    expect(page.next).toBeNull();
    const cut = await withTenantForUser(db.app, alice, a, (tx) => repo.listIncidentHistory(tx, blog, { now: NOW, limit: 6 }));
    expect(cut.next).not.toBeNull();
    const rest = await withTenantForUser(db.app, alice, a, (tx) => repo.listIncidentHistory(tx, blog, { now: NOW, limit: 6, after: cut.next }));
    expect(rest.incidents).toHaveLength(1);
    expect(rest.next).toBeNull();
  });

  it("never shows another project's or another tenant's incidents", async () => {
    const shopIncident = await insert(a, shop, { lastSeen: ago(0, 5000) });
    const bobIncident = await insert(b, bobs, { lastSeen: ago(0, 5000), status: "open" });

    const shopIds = (await allPages(shop, 25)).ids;
    const blogIds = (await allPages(blog, 25)).ids;
    expect(shopIds).toContain(shopIncident);
    expect(blogIds).not.toContain(shopIncident);
    expect(shopIds).not.toContain(bobIncident);
    expect(blogIds).not.toContain(bobIncident);

    // Another project's incident under this project's ID: null.
    expect(await withTenantForUser(db.app, alice, a, (tx) => repo.getIncident(tx, blog, shopIncident, NOW))).toBeNull();
    // Bob's incident, asked for by Alice under Bob's project ID and under her own: null.
    expect(await withTenantForUser(db.app, alice, a, (tx) => repo.getIncident(tx, bobs, bobIncident, NOW))).toBeNull();
    expect(await withTenantForUser(db.app, alice, a, (tx) => repo.getIncident(tx, shop, bobIncident, NOW))).toBeNull();
    expect((await withTenantForUser(db.app, alice, a, (tx) => repo.listIncidentHistory(tx, bobs, { now: NOW, limit: 25 }))).incidents).toEqual([]);
    // Alice's incident under Bob's tenant: null. Bob still sees his own.
    expect(await withTenantForUser(db.app, bob, b, (tx) => repo.getIncident(tx, shop, shopIncident, NOW))).toBeNull();
    expect((await withTenantForUser(db.app, bob, b, (tx) => repo.getIncident(tx, bobs, bobIncident, NOW)))?.id).toBe(bobIncident);
  });

  it("returns an empty first page for a project with no incidents", async () => {
    const empty = await withTenant(db.app, a, async (tx) => {
      const conn = await repo.createConnection(tx, db.vault, { label: "Supabase", token: "tok" });
      return repo.createProject(tx, { connectionId: conn, supabaseRef: "historyrefemptyaaaa4", name: "Empty" });
    });
    expect(await withTenantForUser(db.app, alice, a, (tx) => repo.listIncidentHistory(tx, empty, { now: NOW, limit: 25 })))
      .toEqual({ incidents: [], next: null });
  });
});
