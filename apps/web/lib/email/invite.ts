import type { ProjectRole } from "@supahound/core/db/people";
import { escapeHtml } from "../security";
import { ROLE_LABEL } from "../people";
import type { RenderedEmail } from "./magicLink";

// The project invite email (issue #24, decision 036). Sent through the same Cloudflare Email
// binding as the sign-in email (decision 014). The project name comes from Supabase and the
// inviter's address from their verified JWT; both are escaped and length-capped. The only link
// is our own accept page.

const cap = (s: string, n: number) => (s.length > n ? `${s.slice(0, n - 1)}…` : s);
// Strip control characters and line breaks so nothing can inject a header-like line in text mail.
// eslint-disable-next-line no-control-regex
const oneLine = (s: string) => s.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();

export interface InviteEmailInput {
  projectName: string;
  role: ProjectRole;
  inviterEmail: string | null;
  link: string;
  expiresInDays: number;
}

export function renderInviteEmail(input: InviteEmailInput): RenderedEmail {
  const project = cap(oneLine(input.projectName), 120);
  const inviter = input.inviterEmail ? cap(oneLine(input.inviterEmail), 320) : null;
  const role = ROLE_LABEL[input.role];
  const who = inviter ? `${inviter} invited you` : "You are invited";
  const lead = `${who} to the project ${project} on Supahound, as ${role}.`;
  const note = `Sign in with this email address to accept. The link works once and expires in ${input.expiresInDays} days. If you did not expect this, ignore this email.`;
  return {
    subject: cap(`Join ${project} on Supahound`, 160),
    text: `${lead}\n\nAccept the invite:\n${input.link}\n\n${note}`,
    html: `<!doctype html><html><body style="font-family:system-ui,sans-serif;color:#0f172a">
<p>${escapeHtml(lead)}</p>
<p><a href="${escapeHtml(input.link)}" style="display:inline-block;padding:10px 16px;background:#0f172a;color:#fff;border-radius:6px;text-decoration:none">Accept the invite</a></p>
<p style="color:#475569;font-size:13px">${escapeHtml(note)}</p>
</body></html>`,
  };
}
