import type { RenderedEmail } from "./email.js";
import { escapeHtml } from "./email.js";
import type { HeartbeatConfig } from "../poller/heartbeat.js";

// The staff heartbeat email (issue #133). Goes to SUPAHOUND_STAFF_ALERT_EMAIL only, never to a
// customer. Built from counts and times only: no tenant, project, ref or error text.

export interface HeartbeatEmailInput {
  stale: { ageMinutes: number } | null;
  failing: { runs: number; unable: number; share: number } | null;
  now: Date;
  config: HeartbeatConfig;
  appUrl: string;
}

function utc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export function renderHeartbeatEmail(input: HeartbeatEmailInput): RenderedEmail {
  const lines: string[] = [];
  if (input.stale) {
    lines.push(
      `No poll run has finished for ${input.stale.ageMinutes} minutes (threshold ${input.config.maxAgeMinutes}). ` +
        "Check the poller's cron, the polls queue and its consumer, and Hyperdrive.",
    );
  }
  if (input.failing) {
    const pct = Math.round(input.failing.share * 100);
    lines.push(
      `${input.failing.unable} of ${input.failing.runs} poll runs in the last hour could not assess (${pct}%, threshold ${Math.round(input.config.unableShare * 100)}%). ` +
        "Check the poller logs for the error codes (rate limits, token refresh, the Management API).",
    );
  }
  const what = input.stale && input.failing ? "polling stopped and failing" : input.stale ? "polling stopped" : "polls failing";
  const subject = `[Supahound staff] Heartbeat: ${what}`;
  const footer = [
    `Checked at ${utc(input.now)}. App: ${input.appUrl}`,
    `You get this because SUPAHOUND_STAFF_ALERT_EMAIL names you. At most one email every ${input.config.throttleHours} hours while the problem lasts.`,
  ];
  const text = [subject, "", ...lines, "", ...footer].join("\n");
  const html = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>${escapeHtml(subject)}</title></head>
<body style="font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a;background:#ffffff;padding:16px">
<h1 style="font-size:18px;margin:0 0 12px">${escapeHtml(subject)}</h1>
${lines.map((l) => `<p style="font-size:15px;line-height:1.5;margin:0 0 12px">${escapeHtml(l)}</p>`).join("\n")}
${footer.map((l) => `<p style="font-size:12px;color:#475569;margin:0 0 4px">${escapeHtml(l)}</p>`).join("\n")}
</body></html>`;
  return { subject, text, html };
}
