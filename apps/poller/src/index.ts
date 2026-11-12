import { applyUsageTiers } from "@supahound/core/billing/flow";
import { stripeGateway } from "@supahound/core/billing/stripeGateway";
import { countDailyUsage } from "@supahound/core/billing/usage";
import { billingMode } from "@supahound/core/db/billing";
import { KEEP_RECORDS_YEARS } from "@supahound/core/db/closure";
import { billedTenants, dataJobTenants, dueProjects } from "@supahound/core/db/repo";
import { runDataJob } from "@supahound/core/datacontrols/flow";
import { explainerFor } from "@supahound/core/explainer/llm";
import { queryLogs } from "@supahound/core/logs/client";
import { queryReadOnly } from "@supahound/core/ownership/client";
import { pollProject, type PollDeps, type PollOutcome } from "@supahound/core/poller/pollProject";
import { projectScope, tenantId as parseTenantId, type ProjectScope, type TenantId } from "@supahound/core/tenancy/scope";
import { TokenVault } from "@supahound/core/vault/vault";
import pg from "pg";

// Cron: list due project scopes through the scheduler role (IDs only) and enqueue one message
// per scope. Queue: poll each scope in its own tenant transactions through the app role.
// Queues deliver at least once; pollProject's claim makes a duplicate message a no-op.
//
// Pools are created per invocation: Workers may not share I/O objects across requests.

// A poll of one project; once a day with billing on, the usage count of one tenant (decision 028);
// once a day, the data job of one tenant: retention, purge, expired records (decision 037).
export type PollMessage = { tenantId: string; projectId: string } | { kind: "usage" | "data"; tenantId: string };

// The daily usage count runs at 00:20 UTC, after Supabase has the previous day's logs.
export const USAGE_CRON = { hour: 0, minute: 20 };

export function isUsageMinute(scheduledTime: number): boolean {
  const t = new Date(scheduledTime);
  return t.getUTCHours() === USAGE_CRON.hour && t.getUTCMinutes() === USAGE_CRON.minute;
}

// The daily data job runs at 00:40 UTC, after the usage count. The cron already fires every
// minute, so no new trigger is needed.
export const DATA_CRON = { hour: 0, minute: 40 };

export function isDataMinute(scheduledTime: number): boolean {
  const t = new Date(scheduledTime);
  return t.getUTCHours() === DATA_CRON.hour && t.getUTCMinutes() === DATA_CRON.minute;
}

function parseTenantMessage(body: unknown, want: "usage" | "data"): TenantId | null {
  if (!body || typeof body !== "object") return null;
  const { kind, tenantId } = body as Record<string, unknown>;
  if (kind !== want || typeof tenantId !== "string") return null;
  try {
    return parseTenantId(tenantId);
  } catch {
    return null;
  }
}

export const parseUsageMessage = (body: unknown) => parseTenantMessage(body, "usage");
export const parseDataMessage = (body: unknown) => parseTenantMessage(body, "data");

const QUEUE_SEND_LIMIT = 100;

export function parseMessage(body: unknown): ProjectScope | null {
  if (!body || typeof body !== "object") return null;
  const { tenantId, projectId } = body as Record<string, unknown>;
  if (typeof tenantId !== "string" || typeof projectId !== "string") return null;
  try {
    return projectScope(tenantId, projectId);
  } catch {
    return null;
  }
}

function log(event: string, fields: Record<string, string | number | boolean | null> = {}): void {
  // Internal IDs and counts only. Never log error text, tokens, refs or customer data.
  console.log(JSON.stringify({ event, ...fields }));
}

export interface PollQueue {
  sendBatch(messages: Iterable<MessageSendRequest<PollMessage>>): Promise<unknown>;
}

export async function enqueueUsage(tenants: TenantId[], queue: PollQueue, kind: "usage" | "data" = "usage"): Promise<number> {
  for (let i = 0; i < tenants.length; i += QUEUE_SEND_LIMIT) {
    await queue.sendBatch(tenants.slice(i, i + QUEUE_SEND_LIMIT).map((t) => ({ body: { kind, tenantId: t } })));
  }
  return tenants.length;
}

export async function enqueueDue(scopes: ProjectScope[], queue: PollQueue): Promise<number> {
  for (let i = 0; i < scopes.length; i += QUEUE_SEND_LIMIT) {
    const chunk = scopes.slice(i, i + QUEUE_SEND_LIMIT);
    await queue.sendBatch(chunk.map((s) => ({ body: { tenantId: s.tenantId, projectId: s.projectId } })));
  }
  return scopes.length;
}

export interface QueueMessageLike {
  body: unknown;
  ack(): void;
  retry(): void;
}

export async function handleMessages(
  messages: readonly QueueMessageLike[],
  poll: (scope: ProjectScope) => Promise<PollOutcome>,
  usage?: (tenant: TenantId) => Promise<void>,
  data?: (tenant: TenantId) => Promise<void>,
): Promise<void> {
  for (const msg of messages) {
    const dataTenant = parseDataMessage(msg.body);
    if (dataTenant) {
      try {
        if (data) await data(dataTenant);
        log("data_job_done", { tenant_id: dataTenant });
        msg.ack();
      } catch {
        log("data_job_crashed", { tenant_id: dataTenant });
        msg.retry();
      }
      continue;
    }
    const tenant = parseUsageMessage(msg.body);
    if (tenant) {
      try {
        if (usage) await usage(tenant);
        log("usage_done", { tenant_id: tenant });
        msg.ack();
      } catch {
        log("usage_crashed", { tenant_id: tenant });
        msg.retry();
      }
      continue;
    }
    const scope = parseMessage(msg.body);
    if (!scope) {
      log("poll_message_invalid");
      msg.ack();
      continue;
    }
    try {
      const outcome = await poll(scope);
      log("poll_done", { project_id: scope.projectId, status: outcome.status });
      msg.ack();
    } catch {
      log("poll_crashed", { project_id: scope.projectId });
      msg.retry();
    }
  }
}

export default {
  async scheduled(_controller, env): Promise<void> {
    const scheduler = new pg.Pool({ connectionString: env.HYPERDRIVE_SCHEDULER.connectionString, max: 1 });
    try {
      const billing = billingMode(env.SUPAHOUND_BILLING);
      const count = await enqueueDue(await dueProjects(scheduler, 60, 1000, billing), env.POLL_QUEUE);
      log("polls_enqueued", { count });
      if (billing === "stripe" && isUsageMinute(_controller.scheduledTime)) {
        log("usage_enqueued", { count: await enqueueUsage(await billedTenants(scheduler), env.POLL_QUEUE) });
      }
      // Every billing mode: retention and purges are privacy promises, not billing.
      if (isDataMinute(_controller.scheduledTime)) {
        const tenants = await dataJobTenants(scheduler, new Date(_controller.scheduledTime), KEEP_RECORDS_YEARS);
        log("data_jobs_enqueued", { count: await enqueueUsage(tenants, env.POLL_QUEUE, "data") });
      }
    } finally {
      await scheduler.end();
    }
  },

  async queue(batch, env): Promise<void> {
    const app = new pg.Pool({ connectionString: env.HYPERDRIVE_APP.connectionString, max: 5 });
    const deps: PollDeps = {
      app,
      vault: TokenVault.fromEnv({ SUPAHOUND_MASTER_KEYS: env.SUPAHOUND_MASTER_KEYS }),
      queryLogs,
      queryPolicies: queryReadOnly,
      oauth: {
        clientId: env.SUPABASE_OAUTH_CLIENT_ID,
        clientSecret: env.SUPABASE_OAUTH_CLIENT_SECRET,
        redirectUri: new URL("/api/supabase/callback", env.APP_URL).toString(),
      },
      // Optional secret (decision 025): without it, alerts use template text and no model is called.
      explain: explainerFor((env as Env & { AI_GATEWAY_API_KEY?: string }).AI_GATEWAY_API_KEY),
      env: { SUPAHOUND_SOURCE_COLUMN: env.SUPAHOUND_SOURCE_COLUMN },
      // Incident alert email (decision 030): one email per incident per member.
      alerts: {
        send: (m) => env.EMAIL.send(m),
        from: { email: env.EMAIL_FROM_ADDRESS, name: env.EMAIL_FROM_NAME },
        appUrl: env.APP_URL,
      },
    };
    // Billing on: count yesterday's requests, set each project's tier, bill it from the next renewal.
    const usage = async (tenant: TenantId) => {
      if (billingMode(env.SUPAHOUND_BILLING) !== "stripe") return;
      const counted = await countDailyUsage(tenant, { app, vault: deps.vault, oauth: deps.oauth, queryLogs, env: deps.env });
      log("usage_counted", { tenant_id: tenant, counted: counted.counted, failed: counted.failed });
      const stripe = stripeGateway({
        secretKey: (env as Env & { STRIPE_SECRET_KEY?: string }).STRIPE_SECRET_KEY ?? "",
        apiUrl: env.STRIPE_API_URL,
        prices: { starter: env.STRIPE_PRICE_STARTER, pro: env.STRIPE_PRICE_PRO },
      });
      await applyUsageTiers({ pool: app, stripe, appUrl: env.APP_URL, now: () => new Date() }, tenant, counted.day);
    };
    try {
      // Counts only in the log: never row contents.
      const data = async (tenant: TenantId) => {
        const outcome = await runDataJob(app, tenant, new Date());
        log("data_job", { tenant_id: tenant, kind: outcome.kind, ...(outcome.kind === "retention" ? outcome.retention : {}) });
      };
      await handleMessages(batch.messages, (scope) => pollProject(scope, deps), usage, data);
    } finally {
      await app.end();
    }
  },
} satisfies ExportedHandler<Env, PollMessage>;
