// The only place Supahound's own Workers write log lines (decision 047, ASVS 16.1.1 and 16.4.3).
// Every line is one JSON object: an event from OPS_EVENTS and only the fields that event allows.
// Field values are internal IDs, enums, counts and flags. A value that fails its field's check is
// dropped and counted, so an email, IP, user agent, token or query string can never reach a line,
// even by mistake. The tail Worker in apps/log-sink copies these lines to R2 for 90 days.
//
// packages/core/test/opsLog.test.ts fails if any other file in apps/ or packages/core/src calls
// console, and if docs/ARCHITECTURE.md's log inventory misses an event listed here.

// How a field's value is checked.
//   id:    a UUID (tenant, project).
//   enum:  a lowercase word: a status, an error code, a Stripe event type.
//   count: a finite number.
//   flag:  a boolean.
//   stripe_event: a Stripe event ID (evt_ and letters and digits).
const FIELD_KINDS = {
  tenant_id: "id",
  project_id: "id",
  status: "enum",
  type: "enum",
  reason: "enum",
  kind: "enum",
  method: "enum",
  role: "enum",
  from: "enum",
  projects: "count",
  reattached: "flag",
  revoked: "flag",
  http_status: "count",
  stripe_event: "stripe_event",
  count: "count",
  counted: "count",
  failed: "count",
  sent: "count",
  templates: "count",
  purged: "flag",
  paying: "flag",
  connections_deleted: "count",
  projects_deleted: "count",
  resolved: "count",
  incidents: "count",
  findings: "count",
  pollRuns: "count",
  oauthStates: "count",
} as const;

export type OpsField = keyof typeof FIELD_KINDS;
export type OpsWorker = "web" | "poller";

interface EventSpec {
  readonly workers: readonly OpsWorker[];
  readonly fields: readonly OpsField[];
  readonly meaning: string;
}

// Every event Supahound logs. docs/ARCHITECTURE.md ("Log inventory") lists the same set.
export const OPS_EVENTS = {
  polls_enqueued: { workers: ["poller"], fields: ["count"], meaning: "Cron: project polls put on the queue" },
  usage_enqueued: { workers: ["poller"], fields: ["count"], meaning: "Cron, 00:20 UTC with billing on: usage counts queued" },
  data_jobs_enqueued: { workers: ["poller"], fields: ["count"], meaning: "Cron, 00:40 UTC: data jobs queued" },
  poll_done: { workers: ["poller"], fields: ["project_id", "status"], meaning: "A project poll finished, with its status" },
  poll_crashed: { workers: ["poller"], fields: ["project_id"], meaning: "A project poll threw; the message is retried" },
  poll_message_invalid: { workers: ["poller"], fields: [], meaning: "A queue message was malformed and dropped" },
  rollup_saturated: { workers: ["poller"], fields: ["project_id", "templates"], meaning: "The rollup hit its row limit in every window" },
  posture_scan_crashed: { workers: ["poller"], fields: ["project_id"], meaning: "The posture scan threw; the poll goes on" },
  alert_email_crashed: { workers: ["poller"], fields: ["project_id"], meaning: "Sending incident alert emails threw" },
  usage_counted: { workers: ["poller"], fields: ["tenant_id", "counted", "failed"], meaning: "Daily usage count of one workspace" },
  usage_done: { workers: ["poller"], fields: ["tenant_id"], meaning: "Usage count and tier update finished" },
  usage_crashed: { workers: ["poller"], fields: ["tenant_id"], meaning: "Usage count threw; the message is retried" },
  data_job: {
    workers: ["poller"],
    fields: ["tenant_id", "paying", "purged", "connections_deleted", "projects_deleted", "resolved", "incidents", "findings", "pollRuns", "oauthStates"],
    meaning: "Daily data job of one workspace: retention and purge counts",
  },
  data_job_done: { workers: ["poller"], fields: ["tenant_id"], meaning: "Data job finished" },
  data_job_crashed: { workers: ["poller"], fields: ["tenant_id"], meaning: "Data job threw; the message is retried" },
  heartbeat: { workers: ["web", "poller"], fields: ["status", "sent", "failed"], meaning: "Staff heartbeat found a problem: email sent or throttled" },
  heartbeat_crashed: { workers: ["web", "poller"], fields: [], meaning: "The staff heartbeat check threw" },
  close_workspace_failed: { workers: ["web"], fields: ["tenant_id"], meaning: "Closing a workspace failed before anything was closed" },
  billing_return_failed: { workers: ["web"], fields: ["tenant_id"], meaning: "The Stripe return page could not sync billing" },
  billing_sync_failed: { workers: ["web"], fields: ["tenant_id"], meaning: "A billing sync after a change failed" },
  sign_in_record_failed: { workers: ["web"], fields: [], meaning: "A verified sign-in could not be recorded as a security event" },
  security_event: {
    workers: ["web"],
    fields: ["kind", "method", "reason", "role", "from", "count", "projects", "reattached", "revoked"],
    meaning: "A security event with no workspace (decision 044)",
  },
  stripe_webhook_failed: { workers: ["web"], fields: ["stripe_event", "type"], meaning: "A verified Stripe webhook failed to process" },
  stripe_webhook_rejected: { workers: ["web"], fields: ["reason"], meaning: "A Stripe webhook had no signature or a bad one" },
  email_hook_rejected: { workers: ["web"], fields: ["reason", "http_status"], meaning: "The Send Email Hook refused a call or could not send" },
} as const satisfies Record<string, EventSpec>;

export type OpsEvent = keyof typeof OPS_EVENTS;
export type OpsValue = string | number | boolean | null;
export type OpsFields<E extends OpsEvent> = Partial<Record<(typeof OPS_EVENTS)[E]["fields"][number], OpsValue>>;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
// Lowercase letters, _ and . only: no digits (so no IP and no hex or base64 token), no @, /, ?, =,
// :, space or capitals.
const ENUM = /^[a-z][a-z_.]{0,47}$/;
const STRIPE_EVENT = /^evt_[A-Za-z0-9]{1,64}$/;

function valid(kind: (typeof FIELD_KINDS)[OpsField], value: unknown): boolean {
  if (value === null) return true;
  switch (kind) {
    case "id": return typeof value === "string" && UUID.test(value);
    case "enum": return typeof value === "string" && ENUM.test(value);
    case "stripe_event": return typeof value === "string" && STRIPE_EVENT.test(value);
    case "count": return typeof value === "number" && Number.isFinite(value);
    case "flag": return typeof value === "boolean";
  }
}

export function isOpsEvent(event: unknown): event is OpsEvent {
  return typeof event === "string" && Object.hasOwn(OPS_EVENTS, event);
}

// The JSON object for one log line. Fields the event does not allow, and values that fail their
// check, are left out; `dropped` counts them so a mistake shows up without leaking the value.
export function opsRecord(event: OpsEvent, fields: Record<string, unknown> = {}): Record<string, OpsValue> {
  const allowed: readonly string[] = OPS_EVENTS[event].fields;
  const out: Record<string, OpsValue> = { event };
  let dropped = 0;
  for (const [key, value] of Object.entries(fields)) {
    if (value === undefined) continue;
    if (allowed.includes(key) && valid(FIELD_KINDS[key as OpsField], value)) out[key] = value as OpsValue;
    else dropped++;
  }
  if (dropped > 0) out.dropped = dropped;
  return out;
}

export function opsLine(event: OpsEvent, fields: Record<string, unknown> = {}): string {
  return JSON.stringify(opsRecord(event, fields));
}

// Writes one line to the Worker's log (Workers Logs, and R2 through the tail Worker).
export function opsLog<E extends OpsEvent>(event: E, fields: OpsFields<E> = {}): void {
  console.log(opsLine(event, fields));
}
