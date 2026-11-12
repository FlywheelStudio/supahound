import { randomUUID } from "node:crypto";
import { expect } from "vitest";
import * as billing from "../../src/db/billing.js";
import * as repo from "../../src/db/repo.js";
import { withTenant } from "../../src/db/tenant.js";
import { tenantId, type ConnectionId, type ProjectId, type TenantId } from "../../src/tenancy/scope.js";
import type { Db } from "./harness.js";

// One tenant with a row in every tenant table (scan funnel, billing, people included). Shared by
// the isolation suite and the data-controls suite, so a purge is checked against the same seed.

// Both tenants watch the SAME Supabase project, the case most likely to leak.
export const SHARED_REF = "abcdefghijklmnopqrst";

export interface Seeded {
  tenant: TenantId;
  connection: ConnectionId;
  project: ProjectId;
  run: string;
  incident: string;
}

export async function seedFullTenant(db: Db, name: string, token: string): Promise<Seeded> {
  const tenant = tenantId(randomUUID());
  return withTenant(db.app, tenant, async (tx) => {
    await repo.createTenant(tx, name);
    const connection = await repo.createConnection(tx, db.vault, { label: `${name} org`, token });
    const project = await repo.createProject(tx, { connectionId: connection, supabaseRef: SHARED_REF, name: `${name} app` });
    const run = await repo.startPollRun(tx, project, { start: new Date(Date.now() - 60_000), end: new Date() });
    const incident = await repo.upsertIncident(tx, project, {
      id: null, status: "open", actor: `user:${name}`, severity: "critical", detectors: ["cross_tenant"],
      signals: ["other_owner"], findingCount: 1, hits: 1, openedAt: new Date(), lastSeenAt: new Date(),
    });
    await repo.insertFindings(tx, project, run, [{
      detector: "cross_tenant", severity: "critical", actor: `user:${name}`, signals: ["other_owner"],
      firstSeen: new Date().toISOString(), lastSeen: new Date().toISOString(), hits: 1,
      evidence: { table: "notes" }, incidentId: incident,
    }]);
    await repo.saveNetworks(tx, project, [16509]);
    await repo.appendAudit(tx, { projectId: project, action: "logs_query", detail: { rows: 1 } });
    await tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'owner')", [tenant, randomUUID()]);
    // People per project (decision 036): a viewer and an open invite.
    const viewer = randomUUID();
    await tx.query("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [tenant, viewer]);
    await tx.query("INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role) VALUES ($1, $2, $3, 'viewer')", [tenant, project, viewer]);
    await tx.query(
      `INSERT INTO supahound.project_invites (tenant_id, project_id, email, role, token_hash, invited_by, expires_at)
       VALUES ($1, $2, $3, 'editor', $4, $5, now() + interval '7 days')`,
      [tenant, project, `invitee@${name.toLowerCase()}.test`, randomUUID().replace(/-/g, "").padEnd(64, "0"), viewer],
    );
    await repo.createOAuthState(tx, {
      userId: randomUUID(), stateHash: randomUUID().replace(/-/g, "").padEnd(64, "0"),
      codeVerifier: "v".repeat(64), expiresAt: new Date(Date.now() + 600_000),
    });
    // Scan funnel rows: a verified domain and a completed scan, one of each per tenant.
    const slug = name.toLowerCase();
    const [domain] = await tx.query<{ id: string }>(
      `INSERT INTO supahound.scan_domains (tenant_id, apex, verification_token, token_expires_at, verified_at, verifying_ip)
       VALUES ($1, $2, $3, now() + interval '1 day', now(), '203.0.113.7') RETURNING id`,
      [tenant, `acme-${slug}.com`, "a".repeat(32)],
    );
    const domainRowId = domain!.id;
    await tx.query(
      `INSERT INTO supahound.scan_authorizations (tenant_id, domain_id, tos_version, email, ip)
       VALUES ($1, $2, 'v1', $3, '203.0.113.7')`,
      [tenant, domainRowId, `founder@acme-${slug}.com`],
    );
    const [scan] = await tx.query<{ id: string }>(
      `INSERT INTO supahound.scans (tenant_id, domain_id, mode, status, score, started_at, finished_at)
       VALUES ($1, $2, 'introductory', 'done', 72, now(), now()) RETURNING id`,
      [tenant, domainRowId],
    );
    const scanRowId = scan!.id;
    await tx.query(
      `INSERT INTO supahound.scan_findings (tenant_id, scan_id, severity, type, endpoint, evidence, fix, supahound_monitor)
       VALUES ($1, $2, 'high', 'rls_missing', '/rest/v1/notes', '{"tables":1}', 'Enable RLS', 'anon_table_read')`,
      [tenant, scanRowId],
    );
    await tx.query("INSERT INTO supahound.scan_jobs (tenant_id, scan_id, state) VALUES ($1, $2, 'queued')", [tenant, scanRowId]);
    // Billing rows (decision 028): a trialing subscription and one processed Stripe event.
    await billing.saveSubscription(tx, {
      id: `sub_${slug}1`, customerId: `cus_${slug}1`, status: "trialing", seats: { starter: 1, pro: 0 },
      trialEnd: new Date(Date.now() + 7 * 86_400_000), currentPeriodEnd: null, cancelAtPeriodEnd: false,
    }, new Date());
    expect(await billing.claimStripeEvent(tx, `evt_${slug}1`, "checkout.session.completed")).toBe(true);
    await billing.saveDailyUsage(tx, project, "2026-11-09", 1234);
    return { tenant, connection, project, run, incident };
  });
}
