import { ALERT_LEVELS } from "@supahound/core/alerts/email";
import { ComingSoon, Notice, Shell } from "../../../../../../../components/Shell";
import { ALERT_LEVEL_LABEL } from "../../../../../../../lib/alerts";
import { mode } from "../../../../../../../lib/billing";
import { can } from "../../../../../../../lib/people";
import { loadProjectPage } from "../../../../../../../lib/projectPage";
import { setEmailAlertsAction } from "../actions";

// Project settings → Notifications (issue #98): the email alert threshold (decision 030) and SMS,
// which is coming in Pro (issue #32).

const ERRORS: Record<string, string> = {
  alerts_role: "Only the project's owners, admins and editors can change email alerts.",
  alerts_level: "Pick an email alert level from the list.",
};

export default async function ProjectNotifications({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const d = await loadProjectPage(params);
  const { tenant, project: p } = d;
  const canEdit = can(d.projectRole, "edit_settings");
  const query = await searchParams;
  const saved = query.alerts && query.alerts in ALERT_LEVEL_LABEL ? ALERT_LEVEL_LABEL[query.alerts as keyof typeof ALERT_LEVEL_LABEL] : null;
  const error = query.error ? ERRORS[query.error] : undefined;

  return (
    <Shell tenant={tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={mode() !== "off"} active={{ kind: "project", project: p, page: "notifications" }}>
      <h1 className="mb-6 text-2xl font-semibold">Notifications</h1>
      {saved && <Notice tone="ok">Email alerts saved: {saved}.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}

      <section aria-labelledby="email-heading" className="mb-6 rounded-md border border-slate-200 bg-white p-6">
        <h2 id="email-heading" className="mb-1 font-semibold">Email</h2>
        <p className="mb-4 text-sm text-slate-600">
          Supahound emails everyone with a role on this project when an incident on {p.name} opens or gets worse, at or above this level.
        </p>
        {canEdit ? (
          <form action={setEmailAlertsAction} className="flex flex-wrap items-center gap-3 text-sm">
            <input type="hidden" name="tenantId" value={tenant} />
            <input type="hidden" name="projectId" value={p.id} />
            <label htmlFor="email-alerts" className="text-slate-700">Send email for</label>
            <select id="email-alerts" name="level" defaultValue={p.emailAlerts} aria-label={`Email alerts for ${p.name}`} className="rounded-md border border-slate-300 bg-white px-2 py-1.5">
              {ALERT_LEVELS.map((l) => (
                <option key={l} value={l}>{ALERT_LEVEL_LABEL[l]}</option>
              ))}
            </select>
            <button className="rounded-md bg-slate-950 px-4 py-1.5 font-medium text-white hover:bg-slate-800">Save</button>
          </form>
        ) : (
          <p className="text-sm">
            Email alerts: {ALERT_LEVEL_LABEL[p.emailAlerts]}. Only the project's owners, admins and editors can change this.
          </p>
        )}
      </section>

      <ComingSoon title="SMS">
        <p className="mb-3">Text messages for critical incidents, included in Pro.</p>
        <fieldset disabled aria-label="SMS alerts (coming soon)" className="flex flex-wrap items-center gap-3 opacity-60">
          <label htmlFor="sms-phone" className="text-slate-700">Phone number</label>
          <input id="sms-phone" type="tel" placeholder="+1 555 010 0000" className="rounded-md border border-slate-300 bg-slate-50 px-2 py-1.5" />
          <button type="button" className="rounded-md border border-slate-300 px-4 py-1.5 font-medium">Save phone number</button>
        </fieldset>
      </ComingSoon>
    </Shell>
  );
}
