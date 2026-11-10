import { dueProjects } from "@supahound/core/db/repo";
import { explainerFor } from "@supahound/core/explainer/llm";
import { queryLogs } from "@supahound/core/logs/client";
import { queryReadOnly } from "@supahound/core/ownership/client";
import { pollProject, type PollDeps, type PollOutcome } from "@supahound/core/poller/pollProject";
import { projectScope, type ProjectScope } from "@supahound/core/tenancy/scope";
import { TokenVault } from "@supahound/core/vault/vault";
import pg from "pg";

// Cron: list due project scopes through the scheduler role (IDs only) and enqueue one message
// per scope. Queue: poll each scope in its own tenant transactions through the app role.
// Queues deliver at least once; pollProject's claim makes a duplicate message a no-op.
//
// Pools are created per invocation: Workers may not share I/O objects across requests.

export interface PollMessage {
  tenantId: string;
  projectId: string;
}

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
): Promise<void> {
  for (const msg of messages) {
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
      const count = await enqueueDue(await dueProjects(scheduler, 60, 1000), env.POLL_QUEUE);
      log("polls_enqueued", { count });
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
    };
    try {
      await handleMessages(batch.messages, (scope) => pollProject(scope, deps));
    } finally {
      await app.end();
    }
  },
} satisfies ExportedHandler<Env, PollMessage>;
