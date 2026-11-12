import { createHash } from "node:crypto";
import * as repo from "@supahound/core/db/repo";
import { withTenant } from "@supahound/core/db/tenant";
import { templateExplanation } from "@supahound/core/explainer/template";
import { queryReadOnly, SqlQueryError } from "@supahound/core/ownership/client";
import { querySecurityAdvisor } from "@supahound/core/posture/advisor";
import { ownershipFromColumns } from "@supahound/core/ownership/ownership";
import { pollProject } from "@supahound/core/poller/pollProject";
import { projectScope, tenantId } from "@supahound/core/tenancy/scope";
import { TokenVault } from "@supahound/core/vault/vault";
import pg from "pg";

// Drives the real detection pipeline (packages/core pollProject) into the E2E database, so the
// dashboard shows incidents the poller produced, not hand-written rows. Supabase's logs API is
// replaced by synthetic rollup rows; the model by the template explainer. Synthetic IDs only.

export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";

// User A reads user B's notes from a cloud host: detector 2 (cross-tenant access).
export const SCRAPE_ROWS = [
  {
    method: "GET", path: "/rest/v1/notes", search: `?user_id=eq.${BOB}`, status: "200", contentRange: "0-49/*",
    userAgent: "python-httpx/0.28.1", asn: "14061", asOrganization: "DigitalOcean, LLC",
    jwtSubject: ALICE, jwtRole: "authenticated", apiKeyRole: "anon", hits: "37",
  },
];

export async function pollAttack(tenant: string, projectName: string, now = new Date()): Promise<void> {
  const app = new pg.Pool({ connectionString: process.env.E2E_APP_DB_URL, max: 2 });
  const vault = TokenVault.fromEnv({ SUPAHOUND_MASTER_KEYS: process.env.E2E_MASTER_KEYS });
  try {
    const t = tenantId(tenant);
    const p = await withTenant(app, t, async (tx) => {
      const conn = await repo.createConnection(tx, vault, { label: "E2E", token: "e2e-static-token" });
      const id = await repo.createProject(tx, { connectionId: conn, supabaseRef: "e2eprojectrefxxxxxxx", name: projectName });
      await repo.setOwnership(tx, id, ownershipFromColumns({ notes: ["user_id"] }));
      return id;
    });
    const seen = new Date(now.getTime() - 4 * 60_000).toISOString();
    const outcome = await pollProject(projectScope(t, p), {
      app, vault, now: () => now,
      queryLogs: async () => SCRAPE_ROWS.map((r) => ({ ...r, first_seen: seen, last_seen: seen })),
      queryPolicies: async () => { throw new Error("queryPolicies called: ownership was hand-set"); },
      explain: async (f) => ({ explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] }),
    });
    if (outcome.status !== "ok") throw new Error(`Poll failed: ${JSON.stringify(outcome)}`);
  } finally {
    await app.end();
  }
}

// A valid 20-character ref per project name, so one workspace can hold several seeded projects.
const refFor = (name: string) => createHash("sha256").update(name).digest("hex").replace(/[^a-z]/g, "").padEnd(20, "x").slice(0, 20);

// A freshly picked project (no ownership yet) polled once: the poll reads its RLS policies through
// a fake read-only SQL endpoint. "forbidden" makes that read fail with HTTP 403 (decision 024).
export async function pollPickedProject(
  tenant: string,
  projectName: string,
  policies: Record<string, unknown>[] | "forbidden",
  now = new Date(),
): Promise<void> {
  const app = new pg.Pool({ connectionString: process.env.E2E_APP_DB_URL, max: 2 });
  const vault = TokenVault.fromEnv({ SUPAHOUND_MASTER_KEYS: process.env.E2E_MASTER_KEYS });
  try {
    const t = tenantId(tenant);
    const p = await withTenant(app, t, async (tx) => {
      const conn = await repo.createConnection(tx, vault, { label: "E2E", token: "e2e-static-token" });
      return repo.createProject(tx, { connectionId: conn, supabaseRef: refFor(projectName), name: projectName });
    });
    const outcome = await pollProject(projectScope(t, p), {
      app, vault, now: () => now,
      queryLogs: async () => [],
      queryPolicies: async () => {
        if (policies === "forbidden") throw new SqlQueryError("forbidden", 403);
        return policies;
      },
      explain: async (f) => ({ explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] }),
    });
    if (outcome.status !== "ok") throw new Error(`Poll failed: ${JSON.stringify(outcome)}`);
  } finally {
    await app.end();
  }
}

export async function adminQuery<T extends pg.QueryResultRow>(sql: string, params: unknown[] = []): Promise<T[]> {
  const c = new pg.Client({ connectionString: process.env.E2E_ADMIN_DB_URL });
  await c.connect();
  try {
    return (await c.query<T>(sql, params)).rows;
  } finally {
    await c.end();
  }
}

export const sha256Hex = (s: string) => createHash("sha256").update(s).digest("hex");

// A Supabase connection with a static token (no refresh), as the OAuth callback would store it.
export async function seedConnection(tenant: string, token: string): Promise<string> {
  const app = new pg.Pool({ connectionString: process.env.E2E_APP_DB_URL, max: 1 });
  const vault = TokenVault.fromEnv({ SUPAHOUND_MASTER_KEYS: process.env.E2E_MASTER_KEYS });
  try {
    return await withTenant(app, tenantId(tenant), (tx) => repo.createConnection(tx, vault, { label: "Supabase", token }));
  } finally {
    await app.end();
  }
}

// What the fake Management API answers for this token (support/fakeManagement.ts).
export async function setSupabaseProjects(token: string, projects: { ref: string; name: string; status?: string }[], status = 200): Promise<void> {
  const res = await fetch(`${process.env.E2E_MGMT_URL}/__test/projects`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token, status, projects }),
  });
  if (!res.ok) throw new Error(`fake management: ${res.status}`);
}

export async function managementCalls(token: string): Promise<number> {
  const calls = (await (await fetch(`${process.env.E2E_MGMT_URL}/__test/calls`)).json()) as { token: string }[];
  return calls.filter((c) => c.token === token).length;
}

export async function userIdFor(email: string): Promise<string> {
  const res = await fetch(`${process.env.E2E_AUTH_URL}/__test/user?email=${encodeURIComponent(email)}`);
  if (!res.ok) throw new Error(`No fake Auth user for ${email}`);
  return ((await res.json()) as { id: string }).id;
}

// A workspace member with the Viewer role on every project the workspace has now: what the
// backfill gives an existing member, or an invite per project (decision 036).
export async function addViewer(tenant: string, userId: string): Promise<void> {
  await adminQuery("INSERT INTO supahound.memberships (tenant_id, user_id, role) VALUES ($1, $2, 'member')", [tenant, userId]);
  await adminQuery(
    `INSERT INTO supahound.project_members (tenant_id, project_id, user_id, role)
     SELECT tenant_id, id, $2, 'viewer' FROM supahound.projects WHERE tenant_id = $1`,
    [tenant, userId],
  );
}

// Posture scan (issue #11). What the fake Management API answers for this ref: catalog rows as
// POSTURE_SQL returns them and Advisor lints, or an HTTP status to fail with.
export async function setPosture(ref: string, catalog: Record<string, unknown>[] | number, advisor: Record<string, unknown>[] | number): Promise<void> {
  const res = await fetch(`${process.env.E2E_MGMT_URL}/__test/posture`, {
    method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ref, catalog, advisor }),
  });
  if (!res.ok) throw new Error(`fake management: ${res.status}`);
}

// One poll of an existing project with the posture scan on, through core's real read-only SQL and
// Security Advisor clients pointed at the fake Management API. Logs are empty; ownership is read
// from no policies.
export async function pollWithPosture(tenant: string, project: string, now = new Date()): Promise<void> {
  const app = new pg.Pool({ connectionString: process.env.E2E_APP_DB_URL, max: 2 });
  const vault = TokenVault.fromEnv({ SUPAHOUND_MASTER_KEYS: process.env.E2E_MASTER_KEYS });
  const baseUrl = process.env.E2E_MGMT_URL;
  try {
    const outcome = await pollProject(projectScope(tenantId(tenant), project), {
      app, vault, now: () => now,
      queryLogs: async () => [],
      queryPolicies: async () => [],
      posture: {
        querySql: (q, o) => queryReadOnly(q, { ...o, baseUrl }),
        queryAdvisor: (ref, o) => querySecurityAdvisor(ref, { ...o, baseUrl }),
      },
      explain: async (f) => ({ explanation: templateExplanation(f), source: "template", model: null, zdrConfirmed: null, attempts: [] }),
    });
    if (outcome.status !== "ok") throw new Error(`Poll failed: ${JSON.stringify(outcome)}`);
  } finally {
    await app.end();
  }
}
