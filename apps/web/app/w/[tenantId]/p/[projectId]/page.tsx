import { needsEnterprise, PRICE_LABEL } from "@supahound/core/billing/policy";
import { listOpenIncidents } from "@supahound/core/db/repo";
import Link from "../../../../../components/NavLink";
import { Notice, SeverityBadge, Shell } from "../../../../../components/Shell";
import { mode } from "../../../../../lib/billing";
import { crossTenantNote } from "../../../../../lib/coverage";
import { incidentPath, projectPath, utc } from "../../../../../lib/nav";
import { ROLE_LABEL } from "../../../../../lib/people";
import { loadProjectPage } from "../../../../../lib/projectPage";

// The project dashboard (issue #98): status, usage and plan, detector coverage, open incidents.

function Stat({ label, value, detail }: { label: string; value: string; detail?: string }) {
  return (
    <div className="rounded-md border border-slate-200 bg-white p-4">
      <p className="text-xs font-medium uppercase tracking-wide text-slate-500">{label}</p>
      <p className="mt-1 text-xl font-semibold">{value}</p>
      {detail && <p className="mt-1 text-xs text-slate-500">{detail}</p>}
    </div>
  );
}

export default async function ProjectDashboard({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const d = await loadProjectPage(params, (tx, p) => listOpenIncidents(tx, 5, p.id));
  const joined = (await searchParams).joined === "1";
  const { tenant, project: p } = d;
  const billingOn = mode() !== "off";
  const tier = d.tiers.find((t) => t.id === p.id);
  const note = crossTenantNote(p.crossTenant);
  const status = p.paused ? "Paused" : p.lastRunStatus === "unable_to_assess" ? "Unable to assess" : p.lastRunStatus === "ok" ? "Watching" : p.lastRunStatus === "running" ? "Polling" : "Waiting for first poll";

  return (
    <Shell tenant={tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={billingOn} active={{ kind: "project", project: p, page: "dashboard" }}>
      <header className="mb-6">
        <h1 className="text-2xl font-semibold">{p.name}</h1>
        <p className="font-mono text-xs text-slate-500">{p.supabaseRef}</p>
      </header>
      {joined && <Notice tone="ok">You joined {p.name} as {ROLE_LABEL[d.projectRole]}.</Notice>}

      <section aria-label="Project status" className="mb-8 grid grid-cols-2 gap-3 md:grid-cols-4">
        <Stat label="Status" value={status} detail={p.lastPolledAt ? `Last poll ${utc(p.lastPolledAt)}` : undefined} />
        <Stat label="Open incidents" value={String(p.openIncidents)} />
        <Stat
          label="Requests, 30 days"
          value={tier?.requests30d == null ? "—" : tier.requests30d.toLocaleString("en-US")}
          detail={tier?.requests30d == null ? "Counted daily" : undefined}
        />
        {billingOn && tier && (
          <Stat label="Plan" value={tier.tier === "pro" ? "Pro" : "Starter"} detail={`${PRICE_LABEL[tier.tier]} per month`} />
        )}
      </section>

      {tier && needsEnterprise(tier.requests30d) && (
        <p className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          This project sends more than 10 million requests a month. It stays on Pro, and we will contact you about Enterprise.
        </p>
      )}
      {note && (
        <p className={`mb-6 rounded-md border p-3 text-sm ${note.tone === "warn" ? "border-amber-200 bg-amber-50 text-amber-900" : "border-slate-200 bg-white text-slate-700"}`}>
          {note.text}
        </p>
      )}

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Open incidents</h2>
          <Link href={projectPath(tenant, p.id, "incidents")} className="text-sm text-slate-600 hover:text-slate-950">All incidents</Link>
        </div>
        {d.extra.length === 0 ? (
          <p className="text-slate-600">No open incidents.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {d.extra.map((i) => (
              <li key={i.id}>
                <Link href={incidentPath(tenant, p.id, i.id)} className="block px-4 py-3 hover:bg-slate-50">
                  <span className="flex flex-wrap items-center gap-3">
                    <SeverityBadge severity={i.severity} />
                    <span className="text-sm text-slate-500">{i.hits} requests · last {utc(i.lastSeenAt)}</span>
                  </span>
                  {i.summary?.summary && <span className="mt-1 block text-sm text-slate-700">{i.summary.summary}</span>}
                </Link>
              </li>
            ))}
          </ul>
        )}
      </section>
    </Shell>
  );
}
