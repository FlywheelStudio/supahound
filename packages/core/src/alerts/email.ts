import { fingerprint, SEVERITY_RANK, type Finding, type Severity } from "../detectors/finding.js";
import type { Explanation } from "../explainer/validate.js";

// The incident alert email (issue #16, decisions 014 and 030). One email per incident per
// recipient, rendered from structured fields and validated (model or template) text only.
//
// Every string that came from outside this file is treated as untrusted, even after the
// explainer's validator: links are stripped, length is capped, then HTML is escaped. The only
// links in the email are Supahound's own dashboard and settings URLs, built from APP_URL.

export type AlertLevel = Severity | "off";
export const ALERT_LEVELS: readonly AlertLevel[] = ["low", "medium", "high", "critical", "off"];

export function isAlertLevel(v: unknown): v is AlertLevel {
  return typeof v === "string" && (ALERT_LEVELS as readonly string[]).includes(v);
}

// True when an incident at this severity emails under this project setting.
export function meetsThreshold(severity: Severity, level: AlertLevel): boolean {
  return level !== "off" && SEVERITY_RANK[severity] >= SEVERITY_RANK[level];
}

// True when the incident should email now: it meets the threshold and no email went out at this
// severity or higher yet. A rise in severity emails again; a repeat at the same level does not.
export function alertDue(severity: Severity, alerted: Severity | null, level: AlertLevel): boolean {
  return meetsThreshold(severity, level) && (alerted === null || SEVERITY_RANK[severity] > SEVERITY_RANK[alerted]);
}

export interface AlertIncident {
  actor: string;
  severity: Severity;
  detectors: string[];
  signals: string[];
  findingCount: number;
  hits: number;
  openedAt: Date;
  lastSeenAt: Date;
}

export interface AlertEmailInput {
  projectName: string;
  incident: AlertIncident;
  // The severity of the previous email for this incident; null for the first one.
  previousSeverity: Severity | null;
  explanation: Explanation | null;
  // https://app.example/w/<tenant>: the only link in the email.
  dashboardUrl: string;
  // https://app.example/w/<tenant>/projects: where the threshold is changed.
  settingsUrl: string;
}

export interface RenderedEmail {
  subject: string;
  text: string;
  html: string;
}

const SEVERITY_LABEL: Record<Severity, string> = { critical: "Critical", high: "High", medium: "Medium", low: "Low" };

// Text and background colors with at least 4.5:1 contrast, readable in light and dark clients.
const SEVERITY_COLOR: Record<Severity, { fg: string; bg: string; border: string }> = {
  critical: { fg: "#ffffff", bg: "#b91c1c", border: "#b91c1c" },
  high: { fg: "#ffffff", bg: "#c2410c", border: "#c2410c" },
  medium: { fg: "#713f12", bg: "#fef3c7", border: "#d97706" },
  low: { fg: "#1e293b", bg: "#e2e8f0", border: "#64748b" },
};

const SEVERITY_MEANING: Record<Severity, string> = {
  critical: "Act now. Data or full database access is likely exposed.",
  high: "Act today. The activity matches a known attack pattern.",
  medium: "Review soon. The activity is unusual but not confirmed harmful.",
  low: "For your information. Review when convenient.",
};

const DETECTOR_LABEL: Record<Finding["detector"], string> = {
  cross_tenant: "Cross-tenant data access",
  service_role_misuse: "Service-role key misuse",
};

const SIGNAL_LABEL: Record<string, string> = {
  other_owner: "Filtered on another user's ID",
  all_but_self: "Asked for every row except its own",
  excludes_other: "Excluded a specific user",
  pattern: "Pattern match on an owner column",
  range: "Range scan on an owner column",
  any_owner: "Asked for rows of any owner",
  browser_caller: "Called from a browser",
  mobile_app_caller: "Called from a mobile app",
  non_hosting_network: "Called from a non-hosting network",
  manual_tool: "Called from a manual tool (curl, scripts)",
  new_network: "Called from a network not seen before",
};

const MAX_SUMMARY = 600;
const MAX_IMPACT = 400;
const MAX_STEP = 200;
const MAX_STEPS = 5;
const MAX_NAME = 80;

export function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

// Removes anything a mail client could turn into a link. The explainer's validator already
// rejects links; this is the second line, because the email is where a link would do harm.
export function stripLinks(s: string): string {
  return s
    .replace(/\b(?:https?|ftp|mailto|javascript|data):\S*/gi, "")
    .replace(/\bwww\.\S+/gi, "")
    .replace(/\b[a-z0-9-]+(?:\.[a-z0-9-]+)*\.(?:com|net|org|io|co|app|dev|ai|xyz|ru|cn|info|me|link|site)\b\S*/gi, "")
    .replace(/[ \t]{2,}/g, " ")
    .trim();
}

export function truncate(s: string, max: number): string {
  const chars = [...s];
  return chars.length <= max ? s : `${chars.slice(0, max - 1).join("").trimEnd()}…`;
}

// No control characters and no line breaks: one line, safe for a subject header.
function oneLine(s: string): string {
  // eslint-disable-next-line no-control-regex -- removing control characters is the point
  return s.replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim();
}

// Untrusted prose → safe plain text.
export function cleanText(s: string, max: number): string {
  return truncate(stripLinks(oneLine(s)), max);
}

// Untrusted prose → safe HTML: clean, escape, then `identifier` → <code>.
export function proseHtml(s: string, max: number): string {
  return escapeHtml(cleanText(s, max)).replace(
    /`([^`]{1,80})`/g,
    '<code style="font-family:ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;font-size:13px;background:#f1f5f9;padding:1px 4px;border-radius:4px">$1</code>',
  );
}

export function actorAlias(actor: string): string {
  if (actor.startsWith("service_role:")) return "The service-role key";
  return `User ${fingerprint(actor).slice(0, 8)}`;
}

function detectorLabel(d: string): string {
  return DETECTOR_LABEL[d as Finding["detector"]] ?? cleanText(d.replace(/_/g, " "), 60);
}

function signalLabel(s: string): string {
  return SIGNAL_LABEL[s] ?? cleanText(s.replace(/_/g, " "), 60);
}

function utc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function plural(n: number, one: string, many = `${one}s`): string {
  return `${n.toLocaleString("en-US")} ${n === 1 ? one : many}`;
}

// A fallback summary when the incident has no stored explanation (for example the threshold was
// lowered after the incident opened). Built from structured fields only.
function fallbackSummary(i: AlertIncident): string {
  const what = i.detectors.map(detectorLabel).join(" and ") || "Unusual activity";
  return `${what} detected: ${plural(i.hits, "request")} in ${plural(i.findingCount, "finding")}.`;
}

function title(input: AlertEmailInput): string {
  const what = input.incident.detectors.map(detectorLabel).join(" + ") || "Unusual activity";
  return input.previousSeverity ? `${what} escalated` : what;
}

export function renderIncidentEmail(input: AlertEmailInput): RenderedEmail {
  const i = input.incident;
  const sev = SEVERITY_LABEL[i.severity];
  const project = cleanText(input.projectName, MAX_NAME) || "Your project";
  const heading = title(input);
  const subject = oneLine(`[${sev}] ${heading} on ${project}`);

  const summary = input.explanation ? cleanText(input.explanation.summary, MAX_SUMMARY) : fallbackSummary(i);
  const summaryHtml = input.explanation ? proseHtml(input.explanation.summary, MAX_SUMMARY) : escapeHtml(fallbackSummary(i));
  const impact = input.explanation ? cleanText(input.explanation.likelyImpact, MAX_IMPACT) : "";
  const impactHtml = input.explanation ? proseHtml(input.explanation.likelyImpact, MAX_IMPACT) : "";
  const stepsRaw = (input.explanation?.nextSteps ?? []).slice(0, MAX_STEPS);
  const steps = stepsRaw.map((s) => cleanText(s, MAX_STEP)).filter((s) => s.length > 0);
  const stepsHtml = stepsRaw.map((s) => proseHtml(s, MAX_STEP)).filter((s) => s.length > 0);

  const facts: [string, string][] = [
    ["Project", project],
    ["Actor", actorAlias(i.actor)],
    ["Detectors", i.detectors.map(detectorLabel).join(", ") || "None"],
    ["Requests", i.hits.toLocaleString("en-US")],
    ["Findings", i.findingCount.toLocaleString("en-US")],
    ["First seen", utc(i.openedAt)],
    ["Last seen", utc(i.lastSeenAt)],
  ];
  const signals = i.signals.map(signalLabel);
  const escalation = input.previousSeverity
    ? `Severity rose from ${SEVERITY_LABEL[input.previousSeverity]} to ${sev}.`
    : null;

  const text = [
    `${sev.toUpperCase()} SEVERITY: ${heading}`,
    SEVERITY_MEANING[i.severity],
    ...(escalation ? [escalation] : []),
    "",
    "WHAT HAPPENED",
    summary,
    ...(impact ? ["", "LIKELY IMPACT", impact] : []),
    ...(steps.length > 0 ? ["", "SUGGESTED REMEDIATION", ...steps.map((s, n) => `${n + 1}. ${s}`)] : []),
    "",
    "INCIDENT DETAILS",
    ...facts.map(([k, v]) => `${k}: ${v}`),
    ...(signals.length > 0 ? [`Signals: ${signals.join("; ")}`] : []),
    "",
    `Open the dashboard: ${input.dashboardUrl}`,
    "",
    "You get this email because you are a member of this Supahound workspace.",
    `Change which severities email you in project settings: ${input.settingsUrl}`,
  ].join("\n");

  const c = SEVERITY_COLOR[i.severity];
  const dashboard = escapeHtml(input.dashboardUrl);
  const settings = escapeHtml(input.settingsUrl);
  const section = (label: string, body: string) =>
    `<tr><td style="padding:0 32px 24px">
<p style="margin:0 0 8px;font-size:12px;font-weight:600;letter-spacing:.06em;text-transform:uppercase;color:#64748b">${label}</p>
${body}
</td></tr>`;
  const factRows = facts
    .map(([k, v]) => `<tr><td style="padding:6px 12px 6px 0;color:#64748b;font-size:14px;white-space:nowrap;vertical-align:top">${escapeHtml(k)}</td><td style="padding:6px 0;font-size:14px;color:#0f172a">${escapeHtml(v)}</td></tr>`)
    .join("");
  const signalItems = signals.map((s) => `<li style="margin:0 0 4px">${escapeHtml(s)}</li>`).join("");
  const stepItems = stepsHtml.map((s) => `<li style="margin:0 0 8px;padding-left:4px">${s}</li>`).join("");
  const preheader = escapeHtml(truncate(`${sev}: ${summary}`, 140));

  const html = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<meta name="color-scheme" content="light">
<meta name="supported-color-schemes" content="light">
<title>${escapeHtml(subject)}</title>
</head>
<body style="margin:0;padding:0;background:#f1f5f9;-webkit-text-size-adjust:100%">
<div style="display:none;max-height:0;overflow:hidden;opacity:0;color:transparent">${preheader}</div>
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="background:#f1f5f9">
<tr><td align="center" style="padding:24px 12px">
<table role="presentation" width="100%" cellpadding="0" cellspacing="0" border="0" style="max-width:600px;background:#ffffff;border:1px solid #e2e8f0;border-radius:8px;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#0f172a">
<tr><td style="padding:20px 32px;border-bottom:1px solid #e2e8f0;font-size:15px;font-weight:700;color:#0f172a">Supahound</td></tr>
<tr><td style="padding:24px 32px 8px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="background:${c.bg};color:${c.fg};border:1px solid ${c.border};border-radius:4px;padding:4px 10px;font-size:12px;font-weight:700;letter-spacing:.06em;text-transform:uppercase">${sev} severity</td>
</tr></table>
<h1 style="margin:16px 0 8px;font-size:22px;line-height:1.3;font-weight:700;color:#0f172a">${escapeHtml(heading)}</h1>
<p style="margin:0 0 4px;font-size:15px;line-height:1.5;color:#334155">on <strong>${escapeHtml(project)}</strong></p>
<p style="margin:12px 0 0;padding:10px 12px;border-left:4px solid ${c.border};background:#f8fafc;font-size:14px;line-height:1.5;color:#334155">${escapeHtml(SEVERITY_MEANING[i.severity])}${escalation ? `<br><strong>${escapeHtml(escalation)}</strong>` : ""}</p>
</td></tr>
<tr><td style="height:16px;line-height:16px">&nbsp;</td></tr>
${section("What happened", `<p style="margin:0;font-size:15px;line-height:1.6;color:#0f172a">${summaryHtml}</p>`)}
${impactHtml ? section("Likely impact", `<p style="margin:0;font-size:15px;line-height:1.6;color:#0f172a">${impactHtml}</p>`) : ""}
${stepItems ? section("Suggested remediation", `<ol style="margin:0;padding-left:20px;font-size:15px;line-height:1.6;color:#0f172a">${stepItems}</ol>`) : ""}
${section("Incident details", `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="width:100%;border-top:1px solid #e2e8f0">${factRows}</table>${signalItems ? `<p style="margin:12px 0 4px;font-size:14px;color:#64748b">Signals</p><ul style="margin:0;padding-left:20px;font-size:14px;line-height:1.5;color:#0f172a">${signalItems}</ul>` : ""}`)}
<tr><td style="padding:0 32px 32px">
<table role="presentation" cellpadding="0" cellspacing="0" border="0"><tr>
<td style="border-radius:6px;background:#0f172a"><a href="${dashboard}" style="display:inline-block;padding:12px 20px;font-size:15px;font-weight:600;color:#ffffff;text-decoration:none;border-radius:6px">Open the dashboard</a></td>
</tr></table>
</td></tr>
<tr><td style="padding:20px 32px;border-top:1px solid #e2e8f0;font-size:12px;line-height:1.6;color:#64748b">
You get this email because you are a member of this Supahound workspace.
<a href="${settings}" style="color:#475569;text-decoration:underline">Change which severities email you</a> in project settings.
</td></tr>
</table>
</td></tr>
</table>
</body>
</html>`;

  return { subject, text, html };
}
