import { isOpsEvent, opsRecord, type OpsValue } from "@supahound/core/logging/opsLog";

// One tail event (one invocation of the web or poller Worker) as a line in R2 (decision 047).
// Built from an allowlist: nothing of the trace item reaches R2 unless it is named here. Request
// headers, bodies, query strings, the cf object (client IP, location) and any console output that
// is not a Supahound event are dropped; dropped log lines are only counted.

export interface LogRecord {
  ts: string;
  worker: string;
  trigger: "fetch" | "scheduled" | "queue" | "alarm" | "rpc" | "other";
  outcome: string;
  cpu_ms: number;
  wall_ms: number;
  method?: string;
  path?: string;
  http_status?: number;
  cron?: string;
  queue?: string;
  batch_size?: number;
  events: Record<string, OpsValue>[];
  exceptions: { name: string; message: string }[];
  dropped_logs: number;
  truncated?: true;
}

const WORKER = /^[a-z0-9-]{1,63}$/;
const WORD = /^[A-Za-z][A-Za-z0-9_-]{0,31}$/;
const METHODS = new Set(["GET", "HEAD", "POST", "PUT", "PATCH", "DELETE", "OPTIONS"]);
const CRON = /^[0-9*/,\- ]{1,64}$/;
// A path segment we keep: letters, digits, _ and -, at most 36 characters (a UUID). Anything else
// (an email, an IP, a token, an encoded value) becomes ":x".
const SEGMENT = /^[A-Za-z0-9_-]{1,36}$/;
const MAX_SEGMENTS = 8;

export function safePath(url: string): string {
  let pathname: string;
  try {
    pathname = new URL(url).pathname; // the query string and fragment never leave this function
  } catch {
    return "/:x";
  }
  const segments = pathname.split("/").filter(Boolean);
  const kept = segments.slice(0, MAX_SEGMENTS).map((s) => (SEGMENT.test(s) ? s : ":x"));
  if (segments.length > MAX_SEGMENTS) kept.push(":more");
  return "/" + kept.join("/");
}

// Exception text can quote a value. Only plain words survive; every other token (numbers, emails,
// IPs, URLs, tokens, anything with = / @ or digits) becomes "_". At most 40 words.
const PLAIN_WORD = /^["'(`]?[A-Za-z_]{1,32}["')`]?[.,:;]?$/;
export function safeMessage(message: unknown): string {
  if (typeof message !== "string") return "";
  const words = message.split(/\s+/).filter(Boolean).slice(0, 40);
  return words.map((w) => (PLAIN_WORD.test(w) ? w : "_")).join(" ");
}

export function safeExceptionName(name: unknown): string {
  return typeof name === "string" && /^[A-Za-z][A-Za-z0-9_]{0,63}$/.test(name) ? name : "Error";
}

// A console line is kept only when it is exactly one opsLog line: one string argument that parses
// to an object whose event is listed in OPS_EVENTS. Its fields are checked again by opsRecord.
export function opsEventFrom(log: TraceLog): Record<string, OpsValue> | null {
  const args: unknown[] = Array.isArray(log.message) ? log.message : [log.message];
  if (args.length !== 1 || typeof args[0] !== "string") return null;
  let parsed: unknown;
  try {
    parsed = JSON.parse(args[0]);
  } catch {
    return null;
  }
  if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) return null;
  const { event, dropped, ...fields } = parsed as Record<string, unknown>;
  if (!isOpsEvent(event)) return null;
  const record = opsRecord(event, fields);
  if (typeof dropped === "number" && Number.isFinite(dropped)) record.dropped = (Number(record.dropped) || 0) + dropped;
  return record;
}

function triggerOf(event: TraceItem["event"]): LogRecord["trigger"] {
  if (!event) return "other";
  if ("request" in event) return "fetch";
  if ("cron" in event) return "scheduled";
  if ("queue" in event) return "queue";
  if ("rpcMethod" in event) return "rpc";
  if ("scheduledTime" in event) return "alarm";
  return "other";
}

export function toRecord(item: TraceItem): LogRecord {
  const events: Record<string, OpsValue>[] = [];
  let dropped = 0;
  for (const log of item.logs) {
    const record = opsEventFrom(log);
    if (record) events.push(record);
    else dropped++;
  }
  const trigger = triggerOf(item.event);
  const record: LogRecord = {
    ts: new Date(item.eventTimestamp ?? Date.now()).toISOString(),
    worker: item.scriptName && WORKER.test(item.scriptName) ? item.scriptName : "unknown",
    trigger,
    outcome: WORD.test(item.outcome) ? item.outcome : "unknown",
    cpu_ms: Number.isFinite(item.cpuTime) ? item.cpuTime : 0,
    wall_ms: Number.isFinite(item.wallTime) ? item.wallTime : 0,
    events,
    exceptions: item.exceptions.map((e) => ({ name: safeExceptionName(e.name), message: safeMessage(e.message) })),
    dropped_logs: dropped,
  };
  const event = item.event;
  if (event && trigger === "fetch" && "request" in event) {
    record.method = METHODS.has(event.request.method) ? event.request.method : "OTHER";
    record.path = safePath(event.request.url);
    if (event.response && Number.isInteger(event.response.status)) record.http_status = event.response.status;
  } else if (event && trigger === "scheduled" && "cron" in event) {
    if (CRON.test(event.cron)) record.cron = event.cron;
  } else if (event && trigger === "queue" && "queue" in event) {
    if (WORKER.test(event.queue)) record.queue = event.queue;
    if (Number.isFinite(event.batchSize)) record.batch_size = event.batchSize;
  }
  if (item.truncated) record.truncated = true;
  return record;
}

// Worth keeping: the invocation logged or threw something, did not end "ok", or answered 5xx.
// A quiet, healthy request or cron run is not written, which keeps R2 writes low.
export function worthKeeping(record: LogRecord): boolean {
  return record.events.length > 0 || record.exceptions.length > 0 || record.dropped_logs > 0
    || record.outcome !== "ok" || (record.http_status ?? 0) >= 500;
}

// logs/YYYY/MM/DD/HH/<ms>-<random>.ndjson, by the UTC time of the first record.
export function objectKey(firstTs: string, random: string): string {
  const d = new Date(firstTs);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `logs/${d.getUTCFullYear()}/${pad(d.getUTCMonth() + 1)}/${pad(d.getUTCDate())}/${pad(d.getUTCHours())}/${d.getTime()}-${random}.ndjson`;
}
