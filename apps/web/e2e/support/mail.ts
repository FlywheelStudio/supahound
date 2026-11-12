import { readFileSync } from "node:fs";
import { expect } from "@playwright/test";

// Emails the Worker sent through its EMAIL binding. Under wrangler dev, Miniflare does not send
// mail: it logs "send_email binding called with MessageBuilder:" with From, To and Subject, and
// writes the text body to a file whose path follows as "Text: <path>". globalSetup tees the
// wrangler output to E2E_WRANGLER_LOG.

// eslint-disable-next-line no-control-regex
const ANSI = /\u001b\[[0-9;]*m/g;

interface SentMail {
  to: string;
  subject: string;
  text: string;
}

function sentMails(): SentMail[] {
  const log = readFileSync(process.env.E2E_WRANGLER_LOG!, "utf8").replace(ANSI, "");
  return log.split("send_email binding called with").slice(1).flatMap((block) => {
    const to = /^To: (.+)$/m.exec(block)?.[1]?.trim();
    const subject = /^Subject: (.+)$/m.exec(block)?.[1]?.trim();
    const path = /^Text: (\S+)$/m.exec(block)?.[1];
    if (!to || !subject || !path) return [];
    return [{ to, subject, text: readFileSync(path, "utf8") }];
  });
}

// The newest email to this address whose subject matches, once it shows up in the log.
export async function lastMailTo(to: string, subject: RegExp): Promise<SentMail> {
  let found: SentMail | undefined;
  await expect.poll(() => {
    found = sentMails().filter((m) => m.to.includes(to) && subject.test(m.subject)).at(-1);
    return found !== undefined;
  }, { timeout: 10_000, message: `no email to ${to} matching ${subject}` }).toBe(true);
  return found!;
}

export function countMailsTo(to: string, subject: RegExp): number {
  return sentMails().filter((m) => m.to.includes(to) && subject.test(m.subject)).length;
}

// The accept link in an invite email, as a path on the app.
export function inviteLinkIn(mail: SentMail): string {
  const m = /https?:\/\/[^\s]+\/invite\?token=[^\s]+/.exec(mail.text);
  if (!m) throw new Error(`No invite link in: ${mail.text}`);
  const url = new URL(m[0]);
  return `${url.pathname}${url.search}`;
}
