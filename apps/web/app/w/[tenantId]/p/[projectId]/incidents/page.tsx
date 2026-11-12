import { actorAlias, detectorLabel } from "@supahound/core/alerts/email";
import { INCIDENT_HISTORY_DAYS, listIncidentHistory } from "@supahound/core/db/repo";
import Link from "../../../../../../components/NavLink";
import { notFound } from "next/navigation";
import { SeverityBadge, Shell } from "../../../../../../components/Shell";
import { StatusBadge } from "../../../../../../components/StatusBadge";
import { mode } from "../../../../../../lib/billing";
import { encodeCursor, HISTORY_PAGE_SIZE, parseCursor } from "../../../../../../lib/incidents";
import { incidentPath, projectPath, utc } from "../../../../../../lib/nav";
import { loadProjectPage } from "../../../../../../lib/projectPage";

// Incident history for one project (issue #44, decision 035): open and resolved incidents of the
// last 30 days, newest first, 25 to a page. The keyset cursor is in the URL (?before=...).

export default async function ProjectIncidents({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const after = parseCursor((await searchParams).before);
  if (after === "invalid") notFound();
  const d = await loadProjectPage(params, (tx, p) =>
    listIncidentHistory(tx, p.id, { now: new Date(), limit: HISTORY_PAGE_SIZE, after }));
  const { tenant, project: p } = d;
  const { incidents, next } = d.extra;
  const base = projectPath(tenant, p.id, "incidents");

  return (
    <Shell tenant={tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={mode() !== "off"} active={{ kind: "project", project: p, page: "incidents" }}>
      <h1 className="mb-1 text-2xl font-semibold">Incidents</h1>
      <p className="mb-6 text-sm text-slate-600">
        Open and resolved incidents for {p.name} from the last {INCIDENT_HISTORY_DAYS} days, newest first. Open incidents stay
        here until they resolve.
      </p>
      {incidents.length === 0 ? (
        <p className="text-slate-600">{after ? "No older incidents." : `No incidents in the last ${INCIDENT_HISTORY_DAYS} days.`}</p>
      ) : (
        <ul aria-label="Incident history" className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
          {incidents.map((i) => (
            <li key={i.id}>
              <Link href={incidentPath(tenant, p.id, i.id)} className="block px-4 py-3 hover:bg-slate-50">
                <span className="flex flex-wrap items-center gap-3">
                  <SeverityBadge severity={i.severity} />
                  <StatusBadge status={i.status} />
                  <span className="text-sm font-medium text-slate-900">{i.detectors.map(detectorLabel).join(", ") || "Unusual activity"}</span>
                </span>
                <span className="mt-1 block text-sm text-slate-500">
                  {actorAlias(i.actor)} · {i.hits.toLocaleString("en-US")} requests · last seen {utc(i.lastSeenAt)}
                </span>
              </Link>
            </li>
          ))}
        </ul>
      )}
      <nav aria-label="Pages" className="mt-4 flex gap-4 text-sm">
        {after && <Link href={base} className="text-slate-600 hover:text-slate-950">Newest</Link>}
        {next && <Link href={`${base}?before=${encodeURIComponent(encodeCursor(next))}`} className="text-slate-600 hover:text-slate-950">Older incidents</Link>}
      </nav>
    </Shell>
  );
}
