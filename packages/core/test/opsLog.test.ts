import { readdirSync, readFileSync } from "node:fs";
import { join, relative } from "node:path";
import { fileURLToPath } from "node:url";
import { describe, expect, it } from "vitest";
import { OPS_EVENTS, opsLine, opsRecord } from "../src/logging/opsLog.js";

// Decision 047: Supahound's own logs are kept in R2 for 90 days, so they must never hold personal
// data. Every log line goes through opsLog, which allows only listed fields with checked values.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const LOGGER = "packages/core/src/logging/opsLog.ts";
const TENANT = "11111111-1111-4111-8111-111111111111";

// Personal data and secrets a log line must never carry.
const FORBIDDEN = [
  "someone@example.com",
  "203.0.113.7",
  "2001:db8::1",
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7)",
  ["eyJhbGciOiJIUzI1NiJ9", "eyJzdWIiOiIxMjMifQ", "c2lnbmF0dXJl"].join("."), // a fake JWT, split for secret scanners
  `${"sbp"}_${"0123456789abcdef".repeat(2)}01234567`, // split for secret scanners
  "/auth/confirm?token_hash=abc&type=magiclink",
  "select=*&email=eq.someone",
  "Bearer abc",
];

describe("opsLog", () => {
  it("writes the event and its allowed fields", () => {
    expect(opsRecord("poll_done", { project_id: TENANT, status: "healthy" })).toEqual({ event: "poll_done", project_id: TENANT, status: "healthy" });
    expect(opsRecord("usage_counted", { tenant_id: TENANT, counted: 3, failed: 0 })).toEqual({ event: "usage_counted", tenant_id: TENANT, counted: 3, failed: 0 });
    expect(opsRecord("stripe_webhook_failed", { stripe_event: "evt_1AbC", type: "invoice.paid" })).toEqual({ event: "stripe_webhook_failed", stripe_event: "evt_1AbC", type: "invoice.paid" });
    expect(JSON.parse(opsLine("data_job", { tenant_id: TENANT, paying: true, pollRuns: 4 }))).toEqual({ event: "data_job", tenant_id: TENANT, paying: true, pollRuns: 4 });
  });

  it.each(FORBIDDEN)("drops %s from every string field", (value) => {
    for (const [event, field] of [
      ["poll_done", "project_id"], ["poll_done", "status"], ["usage_done", "tenant_id"],
      ["stripe_webhook_failed", "stripe_event"], ["stripe_webhook_failed", "type"], ["email_hook_rejected", "reason"],
    ] as const) {
      const line = opsLine(event, { [field]: value });
      expect(line).not.toContain(value);
      expect(JSON.parse(line)).toEqual({ event, dropped: 1 });
    }
  });

  it("drops fields the event does not list, whatever their name", () => {
    const line = opsLine("poll_done", { project_id: TENANT, email: "someone@example.com", ip: "203.0.113.7", user_agent: "curl/8", url: "/x?y=z", tenant_id: TENANT });
    expect(JSON.parse(line)).toEqual({ event: "poll_done", project_id: TENANT, dropped: 5 });
  });

  it("drops values of the wrong kind", () => {
    expect(opsRecord("polls_enqueued", { count: "12" })).toEqual({ event: "polls_enqueued", dropped: 1 });
    expect(opsRecord("polls_enqueued", { count: Number.NaN })).toEqual({ event: "polls_enqueued", dropped: 1 });
    expect(opsRecord("data_job", { paying: "yes" })).toEqual({ event: "data_job", dropped: 1 });
    expect(opsRecord("poll_done", { status: { nested: "someone@example.com" } })).toEqual({ event: "poll_done", dropped: 1 });
  });
});

// Every file that runs in a Worker: apps/*/ and packages/core/src, without tests, E2E and output.
const SKIP_DIRS = new Set(["node_modules", "dist", ".wrangler", ".vinext", ".next", "test", "e2e", "playwright-report", "test-results", "public"]);
function sourceFiles(dir: string): string[] {
  return readdirSync(dir, { withFileTypes: true }).flatMap((entry) => {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) return SKIP_DIRS.has(entry.name) ? [] : sourceFiles(path);
    if (!/\.(ts|tsx|mts|cts|js|mjs|cjs)$/.test(entry.name) || entry.name.endsWith(".d.ts")) return [];
    return [relative(root, path)];
  });
}

describe("log guard", () => {
  const files = [...sourceFiles(join(root, "apps")), ...sourceFiles(join(root, "packages/core/src"))];

  it("finds the Worker sources", () => {
    expect(files).toContain("apps/poller/src/index.ts");
    expect(files).toContain("apps/web/lib/billing.ts");
    expect(files).toContain(LOGGER);
  });

  it("lets only the opsLog module call console", () => {
    const offenders = files.filter((file) => file !== LOGGER && /\bconsole\s*[.[]/.test(readFileSync(join(root, file), "utf8")));
    expect(offenders).toEqual([]);
  });

  it("lists every event in docs/ARCHITECTURE.md's log inventory (ASVS 16.1.1)", () => {
    const doc = readFileSync(join(root, "docs/ARCHITECTURE.md"), "utf8");
    const section = doc.split(/^## /m).find((s) => s.startsWith("Log inventory"));
    expect(section).toBeDefined();
    const missing = Object.keys(OPS_EVENTS).filter((event) => !section!.includes(`\`${event}\``));
    expect(missing).toEqual([]);
  });
});
