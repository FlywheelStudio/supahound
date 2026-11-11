import { listOpenIncidents } from "@supahound/core/db/repo";
import { SeverityBadge, Shell } from "../../../../../../components/Shell";
import { mode } from "../../../../../../lib/billing";
import { utc } from "../../../../../../lib/nav";
import { loadProjectPage } from "../../../../../../lib/projectPage";

// Incidents for one project (issue #98). Open incidents only for now; the 30-day history and the
// incident detail page come with issue #44.

export default async function ProjectIncidents({ params }: { params: Promise<{ tenantId: string; projectId: string }> }) {
  const d = await loadProjectPage(params, (tx, p) => listOpenIncidents(tx, 100, p.id));
  const { tenant, project: p } = d;
  return (
    <Shell tenant={tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={mode() !== "off"} active={{ kind: "project", project: p, page: "incidents" }}>
      <h1 className="mb-1 text-2xl font-semibold">Incidents</h1>
      <p className="mb-6 text-sm text-slate-600">Open incidents for {p.name}, worst first. Resolved incidents and the 30-day history are coming soon.</p>
      {d.extra.length === 0 ? (
        <p className="text-slate-600">No open incidents.</p>
      ) : (
        <ul aria-label="Open incidents" className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
          {d.extra.map((i) => (
            <li key={i.id} className="px-4 py-3">
              <div className="flex flex-wrap items-center gap-3">
                <SeverityBadge severity={i.severity} />
                <span className="text-sm text-slate-700">{i.detectors.join(", ")}</span>
                <span className="text-sm text-slate-500">{i.hits} requests · last {utc(i.lastSeenAt)}</span>
              </div>
              {i.summary?.summary && <p className="mt-1 text-sm text-slate-700">{i.summary.summary}</p>}
            </li>
          ))}
        </ul>
      )}
    </Shell>
  );
}
