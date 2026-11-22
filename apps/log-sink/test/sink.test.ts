import { opsLine } from "@supahound/core/logging/opsLog";
import { describe, expect, it } from "vitest";
import { writeTail } from "../src/index";
import { objectKey, safeMessage, safePath, toRecord } from "../src/record";

// Decision 047: what the tail Worker writes to R2. Every test checks the stored text, not only the
// returned object, so a leak through any field fails.
const PROJECT = "22222222-2222-4222-8222-222222222222";
const T = Date.UTC(2026, 10, 22, 7, 5, 9);

const SECRETS = [
  "someone@example.com", "203.0.113.7", "2001:db8::1", "Mozilla/5.0", "token_hash", "abc123secret",
  "eyJhbGciOiJIUzI1NiJ9", "Bearer", "cookie", "sb-access-token", "authorization", "Frankfurt",
];

function log(...message: unknown[]): TraceLog {
  return { timestamp: T, level: "log", message };
}

function item(overrides: Partial<Record<keyof TraceItem, unknown>> = {}): TraceItem {
  return {
    event: null, eventTimestamp: T, logs: [], exceptions: [], diagnosticsChannelEvents: [],
    scriptName: "supahound-poller", outcome: "ok", executionModel: "stateless", truncated: false,
    cpuTime: 3, wallTime: 40, ...overrides,
  } as TraceItem;
}

function fetchItem(url: string, status: number, logs: TraceLog[] = []): TraceItem {
  return item({
    scriptName: "supahound-web",
    event: {
      request: {
        method: "POST", url,
        headers: { cookie: "sb-access-token=abc123secret", authorization: "Bearer eyJhbGciOiJIUzI1NiJ9", "user-agent": "Mozilla/5.0", "x-real-ip": "203.0.113.7" },
        cf: { clientIp: "203.0.113.7", city: "Frankfurt", asn: 13335 },
        getUnredacted() { return this; },
      },
      response: { status },
    },
    logs,
  });
}

class FakeBucket {
  puts: { key: string; body: string; type?: string }[] = [];
  async put(key: string, body: string, opts?: { httpMetadata?: { contentType?: string } }) {
    this.puts.push({ key, body, type: opts?.httpMetadata?.contentType });
    return null;
  }
}

async function stored(events: TraceItem[]): Promise<{ key: string | null; text: string; lines: Record<string, unknown>[] }> {
  const bucket = new FakeBucket();
  const key = await writeTail(events, { LOGS: bucket as unknown as R2Bucket }, () => "r");
  const text = bucket.puts.map((p) => p.body).join("");
  return { key, text, lines: text.split("\n").filter(Boolean).map((l) => JSON.parse(l)) };
}

describe("log sink", () => {
  it("writes Supahound events as NDJSON under logs/YYYY/MM/DD/HH", async () => {
    const out = await stored([item({
      event: { queue: "supahound-polls", batchSize: 2 },
      logs: [log(opsLine("poll_done", { project_id: PROJECT, status: "healthy" }))],
    })]);
    expect(out.key).toBe(`logs/2026/11/22/07/${T}-r.ndjson`);
    expect(out.text.endsWith("\n")).toBe(true);
    expect(out.lines).toEqual([{
      ts: "2026-11-22T07:05:09.000Z", worker: "supahound-poller", trigger: "queue", outcome: "ok", cpu_ms: 3, wall_ms: 40,
      queue: "supahound-polls", batch_size: 2,
      events: [{ event: "poll_done", project_id: PROJECT, status: "healthy" }], exceptions: [], dropped_logs: 0,
    }]);
  });

  it("keeps method, a scrubbed path and the status of a request, never headers, query or cf", async () => {
    const out = await stored([fetchItem("https://app.example/api/stripe/webhook?token_hash=abc123secret&email=someone@example.com", 400, [
      log(opsLine("stripe_webhook_rejected", { reason: "invalid_signature" })),
    ])]);
    expect(out.lines[0]).toMatchObject({ worker: "supahound-web", trigger: "fetch", method: "POST", path: "/api/stripe/webhook", http_status: 400 });
    for (const s of SECRETS) expect(out.text).not.toContain(s);
  });

  it("drops console output that is not one opsLog line, and counts it", async () => {
    const out = await stored([fetchItem("https://app.example/app", 500, [
      log("Error rendering /app for someone@example.com from 203.0.113.7"),
      log(JSON.stringify({ event: "made_up", email: "someone@example.com" })),
      log(JSON.stringify({ event: "poll_done", project_id: "someone@example.com" }), "extra"),
      log({ event: "poll_done" }),
      log(JSON.stringify({ event: "billing_sync_failed", tenant_id: PROJECT, ip: "203.0.113.7" })),
    ])]);
    expect(out.lines[0]!.dropped_logs).toBe(4);
    expect(out.lines[0]!.events).toEqual([{ event: "billing_sync_failed", tenant_id: PROJECT, dropped: 1 }]);
    for (const s of SECRETS) expect(out.text).not.toContain(s);
  });

  it("keeps security events (decision 044) with their enum fields only", async () => {
    const out = await stored([fetchItem("https://app.example/w/x", 403, [
      log(opsLine("security_event", { kind: "csrf_rejected", method: "post" })),
      log(JSON.stringify({ event: "security_event", kind: "csrf_rejected", reason: "someone@example.com" })),
    ])]);
    expect(out.lines[0]!.events).toEqual([
      { event: "security_event", kind: "csrf_rejected", method: "post" },
      { event: "security_event", kind: "csrf_rejected", dropped: 1 },
    ]);
    for (const s of SECRETS) expect(out.text).not.toContain(s);
  });

  it("keeps exception names and plain words of the message only", async () => {
    const out = await stored([item({
      outcome: "exception",
      event: { cron: "* * * * *", scheduledTime: T },
      exceptions: [{ timestamp: T, name: "TypeError", message: "Cannot read user someone@example.com at 203.0.113.7 with Bearer eyJhbGciOiJIUzI1NiJ9 via /x?token_hash=abc123secret", stack: "at Mozilla/5.0" }],
    })]);
    expect(out.lines[0]).toMatchObject({ trigger: "scheduled", cron: "* * * * *", outcome: "exception" });
    expect(out.lines[0]!.exceptions).toEqual([{ name: "TypeError", message: "Cannot read user _ at _ with Bearer _ via _" }]);
    // "Bearer" is a plain word; the token after it is not.
    for (const s of SECRETS.filter((x) => x !== "Bearer")) expect(out.text).not.toContain(s);
  });

  it("writes nothing for quiet, healthy invocations", async () => {
    expect((await stored([fetchItem("https://app.example/app", 200), item({ event: { cron: "* * * * *", scheduledTime: T } })])).key).toBeNull();
  });

  it("keeps 5xx answers and failed outcomes even without logs", async () => {
    expect((await stored([fetchItem("https://app.example/app", 503)])).lines).toHaveLength(1);
    expect((await stored([item({ outcome: "exceededCpu" })])).lines[0]!.outcome).toBe("exceededCpu");
  });

  it("writes one object per tail call, one line per kept invocation", async () => {
    const bucket = new FakeBucket();
    await writeTail([
      item({ logs: [log(opsLine("polls_enqueued", { count: 3 }))] }),
      item(),
      item({ logs: [log(opsLine("heartbeat_crashed"))] }),
    ], { LOGS: bucket as unknown as R2Bucket }, () => "r");
    expect(bucket.puts).toHaveLength(1);
    expect(bucket.puts[0]!.type).toBe("application/x-ndjson");
    expect(bucket.puts[0]!.body.split("\n").filter(Boolean)).toHaveLength(2);
  });
});

describe("scrubbers", () => {
  it.each([
    ["https://a.example/w/22222222-2222-4222-8222-222222222222/incidents?x=1", "/w/22222222-2222-4222-8222-222222222222/incidents"],
    ["https://a.example/someone@example.com", "/:x"],
    ["https://a.example/203.0.113.7/x", "/:x/x"],
    // Split so secret scanners do not read the fake token as a real one.
    [`https://a.example/t/${"sbp"}_${"0123456789abcdef".repeat(2)}01234567`, "/t/:x"],
    ["https://a.example/%40user", "/:x"],
    ["https://a.example/a/b/c/d/e/f/g/h/i/j", "/a/b/c/d/e/f/g/h/:more"],
    ["not a url", "/:x"],
  ])("safePath(%s) is %s", (url, path) => {
    expect(safePath(url)).toBe(path);
  });

  it("safeMessage keeps plain words only", () => {
    expect(safeMessage('relation "poll_runs" does not exist')).toBe('relation "poll_runs" does not exist');
    expect(safeMessage("connect ECONNREFUSED 10.0.0.1:5432")).toBe("connect ECONNREFUSED _");
    expect(safeMessage(undefined)).toBe("");
  });

  it("objectKey pads the UTC date and hour", () => {
    expect(objectKey("2027-01-02T03:04:05.000Z", "z")).toBe(`logs/2027/01/02/03/${Date.UTC(2027, 0, 2, 3, 4, 5)}-z.ndjson`);
  });

  it("toRecord never copies an unknown worker or outcome string", () => {
    const r = toRecord(item({ scriptName: "someone@example.com", outcome: "203.0.113.7" }));
    expect(r.worker).toBe("unknown");
    expect(r.outcome).toBe("unknown");
  });
});
