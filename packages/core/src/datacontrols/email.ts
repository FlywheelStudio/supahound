import { escapeHtml, truncate, type RenderedEmail } from "../alerts/email.js";

// The email every member of the affected projects gets when a Supabase connection is disconnected
// (decision 037): by a person in Supahound, or revoked outside Supahound (the poller saw the grant
// end). Plain facts only: who, when, which projects, and what happens to their history.

export interface DisconnectEmailInput {
  kind: "user" | "revoked";
  workspaceName: string;
  label: string;
  // The person who disconnected, from their verified session (kind "user").
  actorEmail: string | null;
  at: Date;
  projects: string[];
  // Decision 037: a workspace that pays keeps its history.
  paying: boolean;
  deleteAfter: Date;
  settingsUrl: string;
}

const utc = (d: Date) => `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
const day = (d: Date) => d.toISOString().slice(0, 10);

export function renderDisconnectEmail(i: DisconnectEmailInput): RenderedEmail {
  const ws = truncate(i.workspaceName, 100);
  const subject = i.kind === "user" ? `Supabase was disconnected from ${ws}` : `Supahound lost access to Supabase for ${ws}`;
  const who = i.kind === "user"
    ? `${i.actorEmail ?? "A workspace owner or admin"} disconnected the Supabase connection "${i.label}" from ${ws} on ${utc(i.at)}.`
    : `On ${utc(i.at)} Supabase told Supahound that its access through the connection "${i.label}" of ${ws} was revoked outside Supahound.`;
  const stopped = i.projects.length > 0
    ? `Supahound deleted its access token and stopped watching: ${i.projects.join(", ")}.`
    : "Supahound deleted its access token. No project was watched through it.";
  const history = i.paying
    ? "While the workspace pays, Supahound keeps these projects' history."
    : `Supahound deletes these projects' history on ${day(i.deleteAfter)} unless someone reconnects the same Supabase organization before then.`;
  const action = i.kind === "user" ? "To watch them again, reconnect Supabase:" : "Reconnect Supabase within 30 days to keep watching them:";
  const text = [who, "", stopped, history, "", `${action} ${i.settingsUrl}`, "", "Supahound"].join("\n");
  const e = escapeHtml;
  const html = [
    `<p>${e(who)}</p>`,
    `<p>${e(stopped)}</p>`,
    `<p>${e(history)}</p>`,
    `<p>${e(action)} <a href="${e(i.settingsUrl)}">${e(i.settingsUrl)}</a></p>`,
    "<p>Supahound</p>",
  ].join("\n");
  return { subject, text, html };
}
