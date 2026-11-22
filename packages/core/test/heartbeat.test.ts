import { describe, expect, it } from "vitest";
import { renderHeartbeatEmail } from "../src/alerts/staff.js";
import type { MinuteBucket, PollHealth } from "../src/db/heartbeat.js";
import {
  evaluateHeartbeat, HEARTBEAT_DEFAULTS, heartbeatRange, runHeartbeat, staffRecipients, type HeartbeatDeps,
} from "../src/poller/heartbeat.js";
import type { OutgoingEmail } from "../src/poller/pollProject.js";

// Staff heartbeat (issue #133): thresholds and the stateless throttle.

const MIN = 60_000;
// A slot boundary: with 6-hour slots, 2026-11-22 12:00 UTC starts a slot.
const SLOT = Date.UTC(2026, 10, 22, 12, 0);
const at = (minutesAfterSlot: number) => new Date(SLOT + minutesAfterSlot * MIN);

// Healthy history: `perMinute` runs finish in every minute of [from, to), `unable` of them failing.
function runs(from: number, to: number, perMinute = 5, unable = 0): MinuteBucket[] {
  const out: MinuteBucket[] = [];
  for (let m = from; m < to; m++) {
    const minute = SLOT / MIN + m;
    out.push({ minute, total: perMinute, unable, last: new Date(minute * MIN + 30_000) });
  }
  return out;
}

const health = (buckets: MinuteBucket[], lastBefore: Date | null = at(-61)): PollHealth => ({ lastBefore, buckets });

describe("heartbeatRange", () => {
  it("reads the current slot plus the hour before it", () => {
    const r = heartbeatRange(at(125));
    expect(r.slotStart).toEqual(at(0));
    expect(r.since).toEqual(at(-60));
    expect(r.until).toEqual(at(125));
  });
});

describe("evaluateHeartbeat thresholds", () => {
  it("is quiet while runs keep finishing and assessing", () => {
    const v = evaluateHeartbeat(health(runs(-60, 30)), at(30), true);
    expect(v).toMatchObject({ stale: null, failing: null, send: false });
  });

  it("flags polling as stopped once the newest finish is older than the threshold", () => {
    // Last finish at minute 9:30; at minute 25 that is 15.5 minutes: over 15.
    const stopped = health(runs(-60, 10));
    expect(evaluateHeartbeat(stopped, at(24), true).stale).toBeNull();
    expect(evaluateHeartbeat(stopped, at(25), true)).toMatchObject({ stale: { ageMinutes: 15 }, failing: null, send: true });
  });

  it("never calls polling stopped when no project is due to be polled", () => {
    expect(evaluateHeartbeat(health(runs(-60, 10)), at(120), false)).toMatchObject({ stale: null, send: false });
  });

  it("never calls polling stopped before any run has finished", () => {
    expect(evaluateHeartbeat(health([], null), at(120), true)).toMatchObject({ stale: null, send: false });
  });

  it("flags failing polls at the unable-to-assess share, with enough runs", () => {
    // 3 of 5 unable every minute: 60% over the last hour.
    expect(evaluateHeartbeat(health(runs(-60, 30, 5, 3)), at(30), true)).toMatchObject({
      stale: null, failing: { runs: 300, unable: 180, share: 0.6 },
    });
    // 2 of 5: 40%, under 50%.
    expect(evaluateHeartbeat(health(runs(-60, 30, 5, 2)), at(30), true).failing).toBeNull();
  });

  it("ignores a high share over too few runs", () => {
    // One run in the last hour, unable: 100% but under minRuns.
    const few = health([{ minute: SLOT / MIN + 20, total: 1, unable: 1, last: at(20) }], at(19));
    const v = evaluateHeartbeat(few, at(21), true, { ...HEARTBEAT_DEFAULTS, maxAgeMinutes: 1000 });
    expect(v.failing).toBeNull();
  });
});

describe("evaluateHeartbeat throttle", () => {
  it("emails in the first breached minute of a slot and not in the minutes after", () => {
    const stopped = health(runs(-60, 10));
    expect(evaluateHeartbeat(stopped, at(25), true).send).toBe(true);
    for (const m of [26, 60, 200, 359]) {
      const v = evaluateHeartbeat(stopped, at(m), true);
      expect(v.stale, `minute ${m}`).not.toBeNull();
      expect(v.send, `minute ${m}`).toBe(false);
    }
  });

  it("sends one reminder at the start of the next slot while the problem lasts", () => {
    // Polling stopped in the previous slot; the new slot starts at minute 360.
    const stopped = health(runs(-60, 10));
    expect(evaluateHeartbeat(stopped, at(360), true).send).toBe(true);
    expect(evaluateHeartbeat(stopped, at(361), true).send).toBe(false);
  });

  it("does not email again in the same slot after a recovery and a second outage", () => {
    // Stopped 10..40 (breached from 25), recovered 40..100, stopped again after 100.
    const flapping = health([...runs(-60, 10), ...runs(40, 100)]);
    expect(evaluateHeartbeat(flapping, at(50), true)).toMatchObject({ stale: null, failing: null, send: false });
    const again = evaluateHeartbeat(flapping, at(120), true);
    expect(again.stale).not.toBeNull();
    expect(again.send).toBe(false);
  });

  it("counts either reason as the slot's one email", () => {
    // Failing first (from minute 0), then also stopped: still only the first minute sends.
    const failingThenStopped = health([...runs(-60, 10, 5, 4)]);
    expect(evaluateHeartbeat(failingThenStopped, at(0), true)).toMatchObject({ send: true });
    expect(evaluateHeartbeat(failingThenStopped, at(25), true)).toMatchObject({ send: false });
  });
});

describe("evaluateHeartbeat checks (issue #159: one owner per check)", () => {
  it("the web cron's stale check ignores failing polls, and its throttle starts at the stale breach", () => {
    // Failing from minute 0, stopped from minute 25 (last finish 9:30).
    const failingThenStopped = health([...runs(-60, 10, 5, 4)]);
    expect(evaluateHeartbeat(failingThenStopped, at(0), true, HEARTBEAT_DEFAULTS, "stale")).toMatchObject({ stale: null, failing: null, send: false });
    expect(evaluateHeartbeat(failingThenStopped, at(25), true, HEARTBEAT_DEFAULTS, "stale")).toMatchObject({ failing: null, send: true });
    expect(evaluateHeartbeat(failingThenStopped, at(26), true, HEARTBEAT_DEFAULTS, "stale").send).toBe(false);
  });

  it("the poller cron's failing check never reports polling as stopped", () => {
    const stopped = health(runs(-60, 10));
    expect(evaluateHeartbeat(stopped, at(25), true, HEARTBEAT_DEFAULTS, "failing")).toMatchObject({ stale: null, failing: null, send: false });
    const failing = health(runs(-60, 30, 5, 3));
    expect(evaluateHeartbeat(failing, at(0), true, HEARTBEAT_DEFAULTS, "failing")).toMatchObject({ stale: null, send: true });
  });

  it("so the two crons never send for the same condition in a slot", () => {
    // Every minute of a slot in which polls fail, then stop: each condition has exactly one sender.
    const b = health([...runs(-60, 10, 5, 4)]);
    const sends = { stale: 0, failing: 0 };
    for (let m = 0; m < 360; m++) {
      if (evaluateHeartbeat(b, at(m), true, HEARTBEAT_DEFAULTS, "stale").send) sends.stale += 1;
      if (evaluateHeartbeat(b, at(m), true, HEARTBEAT_DEFAULTS, "failing").send) sends.failing += 1;
    }
    expect(sends).toEqual({ stale: 1, failing: 1 });
  });
});

describe("staffRecipients", () => {
  it("reads one address or a comma-separated list, and is off when empty", () => {
    expect(staffRecipients("ops@example.com")).toEqual(["ops@example.com"]);
    expect(staffRecipients(" a@example.com, b@example.org ,")).toEqual(["a@example.com", "b@example.org"]);
    expect(staffRecipients("")).toEqual([]);
    expect(staffRecipients(undefined)).toEqual([]);
    expect(staffRecipients("not an address, Name <x@example.com>")).toEqual([]);
  });
});

// A scheduler pool that answers the heartbeat's three queries from fixed data.
function fakeScheduler(opts: { due: boolean; lastBefore: Date | null; buckets: MinuteBucket[] }) {
  const queries: string[] = [];
  const pool = {
    query: async (sql: string) => {
      queries.push(sql);
      if (sql.includes("FROM supahound.projects")) {
        return { rows: opts.due ? [{ tenant_id: "7d3f2a1e-0b4c-4d5e-8f60-718293a4b5c6", id: "1a2b3c4d-5e6f-4a1b-8c2d-3e4f5a6b7c8d" }] : [] };
      }
      if (sql.includes("finished_at < $1")) return { rows: [{ last: opts.lastBefore }] };
      if (sql.includes("GROUP BY 1")) {
        return { rows: opts.buckets.map((b) => ({ minute: String(b.minute), total: b.total, unable: b.unable, last: b.last })) };
      }
      throw new Error(`unexpected query: ${sql}`);
    },
  };
  return { pool, queries };
}

describe("runHeartbeat", () => {
  const sent: OutgoingEmail[] = [];
  const base = (over: Partial<HeartbeatDeps>): HeartbeatDeps => ({
    scheduler: fakeScheduler({ due: true, lastBefore: at(-61), buckets: runs(-60, 10) }).pool as never,
    billing: "off",
    staffEmail: "ops@example.com",
    send: async (m) => { sent.push(m); },
    from: { email: "alerts@example.com", name: "Supahound alerts" },
    appUrl: "https://app.example",
    ...over,
  });

  it("does nothing, not even a query, with no staff address", async () => {
    const { pool, queries } = fakeScheduler({ due: true, lastBefore: null, buckets: [] });
    expect(await runHeartbeat(base({ scheduler: pool as never, staffEmail: "" }), at(25))).toEqual({ status: "off" });
    expect(queries).toEqual([]);
  });

  it("emails each staff address once in the first breached minute, then holds off", async () => {
    sent.length = 0;
    const deps = base({ staffEmail: "ops@example.com,oncall@example.com" });
    expect(await runHeartbeat(deps, at(25))).toEqual({ status: "sent", sent: 2, failed: 0 });
    expect(sent.map((m) => m.to)).toEqual(["ops@example.com", "oncall@example.com"]);
    expect(sent[0]!.subject).toBe("[Supahound staff] Heartbeat: polling stopped");
    expect(await runHeartbeat(deps, at(26))).toEqual({ status: "throttled" });
    expect(sent).toHaveLength(2);
  });

  it("reports healthy when nothing is over a threshold", async () => {
    const { pool } = fakeScheduler({ due: true, lastBefore: at(-61), buckets: runs(-60, 30) });
    expect(await runHeartbeat(base({ scheduler: pool as never }), at(30))).toEqual({ status: "healthy" });
  });

  it("with the failing check only, skips the due-projects query and reports nothing stale", async () => {
    const { pool, queries } = fakeScheduler({ due: true, lastBefore: at(-61), buckets: runs(-60, 10) });
    expect(await runHeartbeat(base({ scheduler: pool as never, checks: "failing" }), at(25))).toEqual({ status: "healthy" });
    expect(queries.some((q) => q.includes("FROM supahound.projects"))).toBe(false);
    const stale = fakeScheduler({ due: true, lastBefore: at(-61), buckets: runs(-60, 10) });
    expect(await runHeartbeat(base({ scheduler: stale.pool as never, checks: "stale" }), at(25))).toMatchObject({ status: "sent" });
  });

  it("counts a failed send instead of throwing", async () => {
    const deps = base({ send: async () => { throw new Error("binding down"); } });
    expect(await runHeartbeat(deps, at(25))).toEqual({ status: "sent", sent: 0, failed: 1 });
  });
});

describe("renderHeartbeatEmail", () => {
  it("states both reasons from counts only and escapes the HTML", () => {
    const e = renderHeartbeatEmail({
      stale: { ageMinutes: 42 }, failing: { runs: 20, unable: 15, share: 0.75 },
      now: at(0), config: HEARTBEAT_DEFAULTS, appUrl: "https://app.example/<x>",
    });
    expect(e.subject).toBe("[Supahound staff] Heartbeat: polling stopped and failing");
    expect(e.text).toContain("No poll run has finished for 42 minutes");
    expect(e.text).toContain("15 of 20 poll runs in the last hour could not assess (75%");
    expect(e.html).toContain("https://app.example/&lt;x&gt;");
    expect(e.html).not.toContain("<x>");
  });
});
