import Link from "next/link";
import { Shell } from "../../../../../../components/Shell";
import { mode } from "../../../../../../lib/billing";
import { utc, workspacePath } from "../../../../../../lib/nav";
import { loadProjectPage } from "../../../../../../lib/projectPage";

// Project settings → General (issue #98): what Supahound watches and how to stop.

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 px-4 py-3 text-sm">
      <dt className="text-slate-600">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

export default async function ProjectGeneral({ params }: { params: Promise<{ tenantId: string; projectId: string }> }) {
  const d = await loadProjectPage(params);
  const { tenant, project: p } = d;
  const canEdit = d.role !== "member";
  return (
    <Shell tenant={tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={mode() !== "off"} active={{ kind: "project", project: p, page: "general" }}>
      <h1 className="mb-6 text-2xl font-semibold">General</h1>
      <dl className="mb-10 divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        <Row label="Name">{p.name}</Row>
        <Row label="Supabase project ref"><span className="font-mono">{p.supabaseRef}</span></Row>
        <Row label="Polling">{p.paused ? "Paused" : "On"}</Row>
        <Row label="Last poll">{p.lastPolledAt ? utc(p.lastPolledAt) : "Not yet"}</Row>
      </dl>
      <p className="mb-10 text-sm text-slate-600">
        The name comes from Supabase. Supahound reads this project&apos;s edge logs and RLS policies with read-only access.
      </p>

      {canEdit && (
        <section aria-labelledby="danger-heading" className="rounded-md border border-red-200 bg-white p-6">
          <h2 id="danger-heading" className="mb-2 font-semibold text-red-900">Remove project</h2>
          <p className="mb-4 text-sm text-slate-700">
            Supahound stops watching {p.name} and deletes its incidents, findings and poll history. Audit log entries are kept.
          </p>
          <Link
            href={`${workspacePath(tenant, "projects")}?remove=${p.id}`}
            className="inline-block rounded-md border border-red-300 px-4 py-2 text-sm font-medium text-red-800 hover:bg-red-50"
          >
            Remove {p.name}…
          </Link>
        </section>
      )}
    </Shell>
  );
}
