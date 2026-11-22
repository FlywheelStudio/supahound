import type { Pool } from "pg";
import { renderHeartbeatEmail } from "../alerts/staff.js";
import type { BillingMode } from "../db/billing.js";
import { pollHealth, type PollHealth } from "../db/heartbeat.js";
import { dueProjects } from "../db/repo.js";
import type { OutgoingEmail } from "./pollProject.js";

// The staff heartbeat (issue #133). Once a minute, on the poller's cron, Supahound checks its own
// polling: how long since any poll run finished, and what share of the last hour's runs could not
// assess. Over a threshold, it emails the staff address (SUPAHOUND_STAFF_ALERT_EMAIL; empty = off).
//
// Throttle without stored state. Time is cut into fixed slots of `throttleHours` (aligned to the
// epoch). The check re-evaluates every minute of the current slot from poll_runs, and emails only in
// the first minute of the slot that is over a threshold. So there is at most one email per slot,
// the first one goes out the minute a problem starts, and a problem that lasts gets one reminder at
// the start of each later slot. Two limits follow, both documented in docs/self-hosting.md:
//   * a cron run that fails in that first minute (or an email that fails to send) is not retried
//     until the next slot;
//   * the check runs inside the poller's cron, so if the cron itself stops, nothing emails. An
//     external uptime check is the only cover for that.

export interface HeartbeatConfig {
  // Stale: no poll run has finished for longer than this while projects are due.
  maxAgeMinutes: number;
  // Failing: at least `minRuns` runs finished in the last hour and this share were unable to assess.
  unableShare: number;
  minRuns: number;
  // At most one email per slot of this many hours.
  throttleHours: number;
}

export const HEARTBEAT_DEFAULTS: HeartbeatConfig = { maxAgeMinutes: 15, unableShare: 0.5, minRuns: 10, throttleHours: 6 };

const MINUTE_MS = 60_000;
const WINDOW_MINUTES = 60;

export interface HeartbeatVerdict {
  // Over the stale threshold now: minutes since the newest finished run.
  stale: { ageMinutes: number } | null;
  // Over the failure threshold now: the last hour's finished runs.
  failing: { runs: number; unable: number; share: number } | null;
  // True only in the first minute of the slot that is over a threshold.
  send: boolean;
  slotStart: Date;
}

// Where the current slot starts, and how far back pollHealth must read to evaluate all of it.
export function heartbeatRange(now: Date, cfg: HeartbeatConfig = HEARTBEAT_DEFAULTS): { slotStart: Date; since: Date; until: Date } {
  const m = Math.floor(now.getTime() / MINUTE_MS);
  const slotMinutes = Math.max(1, Math.round(cfg.throttleHours * 60));
  const slotStart = m - (m % slotMinutes);
  return {
    slotStart: new Date(slotStart * MINUTE_MS),
    since: new Date((slotStart - WINDOW_MINUTES) * MINUTE_MS),
    until: new Date(m * MINUTE_MS),
  };
}

// Pure: evaluates every minute of the current slot up to `now` from the per-minute buckets.
// `pollable` is false when no project is due to be polled at all; then nothing is stale.
export function evaluateHeartbeat(health: PollHealth, now: Date, pollable: boolean, cfg: HeartbeatConfig = HEARTBEAT_DEFAULTS): HeartbeatVerdict {
  const { slotStart } = heartbeatRange(now, cfg);
  const first = slotStart.getTime() / MINUTE_MS;
  const current = Math.floor(now.getTime() / MINUTE_MS);
  const buckets = [...health.buckets].sort((a, b) => a.minute - b.minute);

  // The state at the start of minute k: runs that finished before k * 60 s.
  const at = (k: number) => {
    let last = health.lastBefore?.getTime() ?? null;
    let runs = 0;
    let unable = 0;
    for (const b of buckets) {
      if (b.minute >= k) break;
      last = last === null ? b.last.getTime() : Math.max(last, b.last.getTime());
      if (b.minute >= k - WINDOW_MINUTES) {
        runs += b.total;
        unable += b.unable;
      }
    }
    const ageMinutes = last === null ? null : (k * MINUTE_MS - last) / MINUTE_MS;
    const stale = pollable && ageMinutes !== null && ageMinutes > cfg.maxAgeMinutes ? { ageMinutes: Math.floor(ageMinutes) } : null;
    const share = runs > 0 ? unable / runs : 0;
    const failing = runs >= cfg.minRuns && share >= cfg.unableShare ? { runs, unable, share } : null;
    return { stale, failing };
  };

  const nowState = at(current);
  const breached = nowState.stale !== null || nowState.failing !== null;
  let earlier = false;
  for (let k = first; breached && !earlier && k < current; k++) {
    const s = at(k);
    earlier = s.stale !== null || s.failing !== null;
  }
  return { ...nowState, send: breached && !earlier, slotStart };
}

// One address or a comma-separated list. Anything that does not look like an address is dropped.
export function staffRecipients(value: string | undefined): string[] {
  return (value ?? "")
    .split(",")
    .map((s) => s.trim())
    .filter((s) => /^[^\s@,<>]+@[^\s@,<>]+\.[^\s@,<>]+$/.test(s));
}

export interface HeartbeatDeps {
  scheduler: Pool;
  billing: BillingMode;
  // SUPAHOUND_STAFF_ALERT_EMAIL: empty or unset turns the heartbeat off.
  staffEmail: string | undefined;
  send: (message: OutgoingEmail) => Promise<unknown>;
  from: { email: string; name: string };
  appUrl: string;
  config?: HeartbeatConfig;
}

export type HeartbeatOutcome =
  | { status: "off" }
  | { status: "healthy" | "throttled" }
  | { status: "sent"; sent: number; failed: number };

export async function runHeartbeat(deps: HeartbeatDeps, now: Date): Promise<HeartbeatOutcome> {
  const to = staffRecipients(deps.staffEmail);
  if (to.length === 0) return { status: "off" };
  const cfg = deps.config ?? HEARTBEAT_DEFAULTS;
  const { since, until } = heartbeatRange(now, cfg);
  // Any project the cron would poll at all; with none, a quiet poll_runs is expected.
  const pollable = (await dueProjects(deps.scheduler, 0, 1, deps.billing)).length > 0;
  const verdict = evaluateHeartbeat(await pollHealth(deps.scheduler, since, until), now, pollable, cfg);
  if (!verdict.stale && !verdict.failing) return { status: "healthy" };
  if (!verdict.send) return { status: "throttled" };
  const rendered = renderHeartbeatEmail({ ...verdict, now, config: cfg, appUrl: deps.appUrl });
  let sent = 0;
  let failed = 0;
  for (const address of to) {
    try {
      await deps.send({ to: address, from: deps.from, ...rendered });
      sent += 1;
    } catch {
      failed += 1;
    }
  }
  return { status: "sent", sent, failed };
}
