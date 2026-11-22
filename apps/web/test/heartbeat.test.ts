import type { HeartbeatDeps } from "@supahound/core/poller/heartbeat";
import { describe, expect, it } from "vitest";
import { scheduledHeartbeat, type HeartbeatEnv, type ScheduledDeps } from "../lib/heartbeat";

// The web Worker's cron (issue #159): the heartbeat's stale check, through the scheduler role.

const NOW = Date.UTC(2026, 10, 22, 12, 25);

const env = (over: Partial<HeartbeatEnv> = {}): HeartbeatEnv => ({
  HYPERDRIVE_SCHEDULER: { connectionString: "postgres://scheduler@hyperdrive/db" },
  EMAIL: { send: async () => undefined },
  SUPAHOUND_STAFF_ALERT_EMAIL: "ops@example.com",
  SUPAHOUND_BILLING: "off",
  EMAIL_FROM_ADDRESS: "login@example.com",
  EMAIL_FROM_NAME: "Supahound",
  APP_URL: "https://app.example",
  ...over,
});

function fakes(heartbeat: ScheduledDeps["heartbeat"]) {
  const pools: string[] = [];
  const logs: string[] = [];
  let ended = 0;
  const deps: ScheduledDeps = {
    pool: (cs) => {
      pools.push(cs);
      return { query: (async () => ({ rows: [] })) as never, end: async () => { ended += 1; } };
    },
    heartbeat,
    log: (event) => { logs.push(event); },
  };
  return { deps, pools, logs, ended: () => ended };
}

describe("scheduledHeartbeat (web cron)", () => {
  it("runs only the stale check, through the scheduler connection, at the cron's time", async () => {
    const calls: { deps: HeartbeatDeps; now: Date }[] = [];
    const sent: unknown[] = [];
    const f = fakes(async (deps, now) => {
      calls.push({ deps, now });
      await deps.send({ to: "ops@example.com", from: deps.from, subject: "s", text: "t", html: "h" });
      return { status: "sent", sent: 1, failed: 0 };
    });
    const e = env({ EMAIL: { send: async (m) => { sent.push(m); } } });
    expect(await scheduledHeartbeat(NOW, e, f.deps)).toEqual({ status: "sent", sent: 1, failed: 0 });
    expect(f.pools).toEqual(["postgres://scheduler@hyperdrive/db"]);
    expect(calls).toHaveLength(1);
    const { deps, now } = calls[0]!;
    expect(now).toEqual(new Date(NOW));
    expect(deps).toMatchObject({
      checks: "stale",
      billing: "off",
      staffEmail: "ops@example.com",
      from: { email: "login@example.com", name: "Supahound" },
      appUrl: "https://app.example",
    });
    expect(sent).toHaveLength(1);
    expect(f.logs).toEqual(["heartbeat"]);
    expect(f.ended()).toBe(1);
  });

  it("is off without a staff address: no pool, no check", async () => {
    const f = fakes(async () => { throw new Error("must not run"); });
    expect(await scheduledHeartbeat(NOW, env({ SUPAHOUND_STAFF_ALERT_EMAIL: " " }), f.deps)).toEqual({ status: "off" });
    expect(await scheduledHeartbeat(NOW, env({ SUPAHOUND_STAFF_ALERT_EMAIL: undefined }), f.deps)).toEqual({ status: "off" });
    expect(f.pools).toEqual([]);
  });

  it("never throws: a failed check is logged and the pool still closes", async () => {
    const f = fakes(async () => { throw new Error("hyperdrive down"); });
    expect(await scheduledHeartbeat(NOW, env(), f.deps)).toBeNull();
    expect(f.logs).toEqual(["heartbeat_crashed"]);
    expect(f.ended()).toBe(1);
  });

  it("never throws on a bad billing mode or a pool that fails to close", async () => {
    const f = fakes(async () => ({ status: "healthy" }));
    f.deps.pool = () => ({ query: (async () => ({ rows: [] })) as never, end: async () => { throw new Error("closed"); } });
    expect(await scheduledHeartbeat(NOW, env({ SUPAHOUND_BILLING: "bogus" }), f.deps)).toBeNull();
    expect(await scheduledHeartbeat(NOW, env(), f.deps)).toEqual({ status: "healthy" });
    expect(f.logs).toEqual(["heartbeat_crashed"]);
  });
});
