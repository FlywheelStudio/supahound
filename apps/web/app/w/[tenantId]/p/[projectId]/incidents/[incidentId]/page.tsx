import { actorAlias, detectorLabel, signalLabel } from "@supahound/core/alerts/email";
import { getIncident } from "@supahound/core/db/repo";
import Link from "../../../../../../../components/NavLink";
import { notFound } from "next/navigation";
import { SeverityBadge, Shell } from "../../../../../../../components/Shell";
import { StatusBadge } from "../../../../../../../components/StatusBadge";
import { mode } from "../../../../../../../lib/billing";
import { codeSegments, durationLabel, explanationOf, fallbackSummary, parseIncidentId } from "../../../../../../../lib/incidents";
import { projectPath, utc } from "../../../../../../../lib/nav";
import { loadProjectPage } from "../../../../../../../lib/projectPage";

// One incident (issue #44, decision 035). The incident is read in the same paid-gate transaction
// as the project list, filtered by tenant, project and the 30-day window. Anything else (another
// project's or workspace's incident, a made-up or malformed ID, an old resolved incident) is a 404.
// The actor shows as an alias, never as the raw user ID (as in the alert email).

function Prose({ text }: { text: string }) {
  return (
    <>
      {codeSegments(text).map((s, n) =>
        s.code ? <code key={n} className="rounded bg-slate-100 px-1 font-mono text-[13px]">{s.text}</code> : <span key={n}>{s.text}</span>,
      )}
    </>
  );
}

function Fact({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div>
      <dt className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</dt>
      <dd className="mt-0.5 text-sm text-slate-900">{children}</dd>
    </div>
  );
}

export default async function IncidentDetail({ params }: { params: Promise<{ tenantId: string; projectId: string; incidentId: string }> }) {
  const id = parseIncidentId((await params).incidentId);
  if (!id) notFound();
  const d = await loadProjectPage(params, (tx, p) => getIncident(tx, p.id, id, new Date()));
  const i = d.extra;
  if (!i) notFound();
  const { tenant, project: p } = d;
  const e = explanationOf(i.summary);
  const what = i.detectors.map(detectorLabel).join(" and ") || "Unusual activity";

  return (
    <Shell tenant={tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={mode() !== "off"} active={{ kind: "project", project: p, page: "incidents" }}>
      <Link href={projectPath(tenant, p.id, "incidents")} className="text-sm text-slate-600 hover:text-slate-950">← All incidents</Link>
      <header className="mb-6 mt-2">
        <h1 className="text-2xl font-semibold">{what}</h1>
        <p className="mt-2 flex flex-wrap items-center gap-3">
          <SeverityBadge severity={i.severity} />
          <StatusBadge status={i.status} />
          <span className="text-sm text-slate-600">{p.name}</span>
        </p>
      </header>

      <section aria-label="Incident facts" className="mb-6 rounded-md border border-slate-200 bg-white p-4">
        <dl className="grid grid-cols-2 gap-4 md:grid-cols-3">
          <Fact label="Actor">{actorAlias(i.actor)}</Fact>
          <Fact label="Requests">{i.hits.toLocaleString("en-US")}</Fact>
          <Fact label="Findings">{i.findingCount.toLocaleString("en-US")}</Fact>
          <Fact label="First seen">{utc(i.openedAt)}</Fact>
          <Fact label="Last seen">{utc(i.lastSeenAt)}</Fact>
          <Fact label="Duration">{durationLabel(i.openedAt, i.lastSeenAt)}</Fact>
        </dl>
      </section>

      <section aria-label="Signals" className="mb-6">
        <h2 className="mb-2 font-semibold">Detectors and signals</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          {i.detectors.map((x) => <li key={`d-${x}`}>{detectorLabel(x)}</li>)}
          {i.signals.map((x) => <li key={`s-${x}`}>{signalLabel(x)}</li>)}
        </ul>
      </section>

      <section aria-label="Summary" className="mb-6">
        <h2 className="mb-2 font-semibold">Summary</h2>
        <p className="text-sm text-slate-700">{e ? <Prose text={e.summary} /> : fallbackSummary(i)}</p>
        {e?.likelyImpact && (
          <p className="mt-2 text-sm text-slate-700"><span className="font-medium">Likely impact: </span><Prose text={e.likelyImpact} /></p>
        )}
      </section>

      {e && e.nextSteps.length > 0 && (
        <section aria-label="Suggested fix">
          <h2 className="mb-2 font-semibold">Suggested fix</h2>
          <ol className="list-decimal space-y-1 pl-5 text-sm text-slate-700">
            {e.nextSteps.map((s, n) => <li key={n}><Prose text={s} /></li>)}
          </ol>
        </section>
      )}
    </Shell>
  );
}
