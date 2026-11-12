import { createHash } from "node:crypto";
import type { Pool } from "pg";
import { escapeHtml, type RenderedEmail } from "../alerts/email.js";

// The subprocessor notice (issue #43, decision 037): before a new subprocessor starts to process
// customer data, every workspace owner gets an email. An operator runs it from the core CLI
// (`pnpm subprocessor-notice`). It reads owners' addresses through supahound_notifier, a role that
// sees owner rows of memberships (tenant_id, role, email) in every tenant and nothing else
// (decision 004: cross-tenant admin work has its own role). It sends through the Cloudflare Email
// Sending REST API, one email per address, so owners never see each other's addresses.

// The notice must reach owners at least this long before the subprocessor takes effect.
export const NOTICE_PERIOD_DAYS = 30;

export interface SubprocessorNotice {
  name: string;
  purpose: string;
  location: string;
  // YYYY-MM-DD, UTC: the first day the subprocessor may process customer data.
  effective: string;
  // Where the current list lives (the privacy policy); optional.
  policyUrl: string | null;
  // Where owners send objections or questions.
  contact: string;
}

const DATE = /^\d{4}-\d{2}-\d{2}$/;
const DAY = 86_400_000;

// Checks a notice before anything is read or sent. Returns the problems, empty when it is fine.
export function noticeProblems(n: SubprocessorNotice, today: Date): string[] {
  const out: string[] = [];
  for (const [k, v, max] of [["name", n.name, 100], ["purpose", n.purpose, 300], ["location", n.location, 100]] as const) {
    if (v.trim() === "" || v.length > max) out.push(`--${k} must be 1 to ${max} characters`);
  }
  if (!DATE.test(n.effective) || Number.isNaN(Date.parse(`${n.effective}T00:00:00Z`))) {
    out.push("--effective must be a date, YYYY-MM-DD");
  } else {
    const startOfToday = Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate());
    const days = (Date.parse(`${n.effective}T00:00:00Z`) - startOfToday) / DAY;
    if (days < NOTICE_PERIOD_DAYS) out.push(`--effective must be at least ${NOTICE_PERIOD_DAYS} days from today (decision 037)`);
  }
  if (n.policyUrl !== null && !/^https:\/\/[^\s]+$/.test(n.policyUrl)) out.push("--policy-url must be an https URL");
  if (!/^[^\s@<>,;"]+@[^\s@<>,;"]+$/.test(n.contact)) out.push("--contact must be an email address");
  return out;
}

export interface Recipients {
  // Distinct, lower-cased addresses of every workspace owner, across workspaces.
  addresses: string[];
  // Owner memberships with no address on file. They get no email; the operator sees the count.
  ownersWithoutAddress: number;
}

// Reads through a pool that logs in as a member of supahound_notifier. RLS shows that role owner
// rows only; the WHERE repeats it. Closed workspaces not yet purged are included: Supahound still
// holds their data.
export async function noticeRecipients(notifier: Pool): Promise<Recipients> {
  const res = await notifier.query<{ email: string | null }>(
    "SELECT email FROM supahound.memberships WHERE role = 'owner'",
  );
  const addresses = [...new Set(res.rows.filter((r) => r.email !== null).map((r) => r.email!.toLowerCase()))].sort();
  return { addresses, ownersWithoutAddress: res.rows.filter((r) => r.email === null).length };
}

export function renderSubprocessorNotice(n: SubprocessorNotice): RenderedEmail {
  const subject = `Supahound adds a subprocessor: ${n.name}`;
  const lines = [
    "Hello,",
    "",
    `You get this email because you own a Supahound workspace. On ${n.effective}, Supahound starts to use a new subprocessor:`,
    "",
    `Subprocessor: ${n.name}`,
    `Purpose: ${n.purpose}`,
    `Location: ${n.location}`,
    "",
    `If you object, reply to ${n.contact} before ${n.effective}. You can also close your workspace from Workspace settings.`,
    ...(n.policyUrl ? ["", `The full list of subprocessors: ${n.policyUrl}`] : []),
    "",
    "Supahound",
  ];
  const e = escapeHtml;
  const html = [
    "<p>Hello,</p>",
    `<p>You get this email because you own a Supahound workspace. On <strong>${e(n.effective)}</strong>, Supahound starts to use a new subprocessor:</p>`,
    "<ul>",
    `<li>Subprocessor: ${e(n.name)}</li>`,
    `<li>Purpose: ${e(n.purpose)}</li>`,
    `<li>Location: ${e(n.location)}</li>`,
    "</ul>",
    `<p>If you object, reply to <a href="mailto:${e(n.contact)}">${e(n.contact)}</a> before ${e(n.effective)}. You can also close your workspace from Workspace settings.</p>`,
    ...(n.policyUrl ? [`<p>The full list of subprocessors: <a href="${e(n.policyUrl)}">${e(n.policyUrl)}</a></p>`] : []),
    "<p>Supahound</p>",
  ].join("\n");
  return { subject, text: lines.join("\n"), html };
}

export interface NoticeEmail extends RenderedEmail {
  to: string;
  from: { address: string; name: string };
  replyTo: string;
}

export type SendFn = (email: NoticeEmail) => Promise<void>;

export class EmailApiError extends Error {
  constructor(readonly status: number, readonly codes: string) {
    super(`Cloudflare Email Sending returned HTTP ${status}${codes ? ` (${codes})` : ""}`);
    this.name = "EmailApiError";
  }
}

// The Cloudflare Email Sending REST API (decision 014: the same email service, from Node).
// https://developers.cloudflare.com/email-service/api/send-emails/rest-api/
export function cloudflareSender(config: { accountId: string; apiToken: string; fetch?: typeof fetch | undefined }): SendFn {
  const url = `https://api.cloudflare.com/client/v4/accounts/${encodeURIComponent(config.accountId)}/email/sending/send`;
  return async (m) => {
    const res = await (config.fetch ?? fetch)(url, {
      method: "POST",
      headers: { Authorization: `Bearer ${config.apiToken}`, "Content-Type": "application/json" },
      body: JSON.stringify({ from: m.from, to: m.to, reply_to: m.replyTo, subject: m.subject, text: m.text, html: m.html }),
      signal: AbortSignal.timeout(15_000),
    });
    let body: { success?: boolean; errors?: { message?: string }[]; result?: { permanent_bounces?: string[] } } = {};
    try {
      body = (await res.json()) as typeof body;
    } catch {
      // A body that is not JSON: the status decides.
    }
    if (!res.ok || body.success === false) {
      // Error codes only: never the response text, which may echo the address.
      throw new EmailApiError(res.status, (body.errors ?? []).map((x) => x.message ?? "").filter(Boolean).join(","));
    }
  };
}

// A line per address already sent: sha256(notice key + address). The address itself is never
// written to disk. A run that stops half way resumes from the journal without sending twice.
export const journalLine = (noticeKey: string, address: string) => createHash("sha256").update(`${noticeKey}\n${address}`).digest("hex");

export const noticeKey = (n: SubprocessorNotice) => `${n.name.trim().toLowerCase()}@${n.effective}`;

export interface SendResult {
  sent: number;
  skipped: number;
  failed: number;
}

// Sends the notice to each address not yet in the journal. Records each success at once.
export async function sendNotice(input: {
  notice: SubprocessorNotice;
  addresses: string[];
  from: { address: string; name: string };
  send: SendFn;
  sent: ReadonlySet<string>;
  record: (line: string) => void;
}): Promise<SendResult> {
  const rendered = renderSubprocessorNotice(input.notice);
  const key = noticeKey(input.notice);
  const out: SendResult = { sent: 0, skipped: 0, failed: 0 };
  for (const to of input.addresses) {
    const line = journalLine(key, to);
    if (input.sent.has(line)) {
      out.skipped += 1;
      continue;
    }
    try {
      await input.send({ to, from: input.from, replyTo: input.notice.contact, ...rendered });
      input.record(line);
      out.sent += 1;
    } catch {
      out.failed += 1;
    }
  }
  return out;
}
