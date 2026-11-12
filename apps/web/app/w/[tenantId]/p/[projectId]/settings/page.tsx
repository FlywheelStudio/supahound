import { listLinkableDomains, listProjectDomains } from "@supahound/core/db/scanDomains";
import Link from "next/link";
import { Notice, Shell } from "../../../../../../components/Shell";
import { mode } from "../../../../../../lib/billing";
import { projectPath, utc, workspacePath } from "../../../../../../lib/nav";
import { canRemoveProject } from "../../../../../../lib/people";
import { loadProjectPage } from "../../../../../../lib/projectPage";
import { canLinkDomains, domainNoticeFrom } from "../../../../../../lib/scanDomains";
import { linkDomainAction, unlinkDomainAction } from "./actions";

// Project settings → General (issue #98): what Supahound watches, the verified domains whose
// security scan belongs to this project (issue #100), and how to stop.

function Row({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="flex flex-wrap justify-between gap-2 px-4 py-3 text-sm">
      <dt className="text-slate-600">{label}</dt>
      <dd className="font-medium">{children}</dd>
    </div>
  );
}

export default async function ProjectGeneral({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const d = await loadProjectPage(params, async (tx, p, role) => ({
    linked: await listProjectDomains(tx, p.id),
    linkable: canLinkDomains(role) ? await listLinkableDomains(tx) : [],
  }));
  const { tenant, project: p } = d;
  const { linked, linkable } = d.extra;
  const canEdit = canRemoveProject(d.projectRole, d.role);
  const canLink = canLinkDomains(d.projectRole);
  const notice = domainNoticeFrom(await searchParams);
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

      <section id="scan-domains" aria-labelledby="domains-heading" className="mb-10 rounded-md border border-slate-200 bg-white p-6">
        <h2 id="domains-heading" className="mb-2 font-semibold">Security scan domains</h2>
        <p className="mb-4 text-sm text-slate-700">
          The latest security scan of each domain here shows on the{" "}
          <Link href={projectPath(tenant, p.id, "findings")} className="underline">Security scan</Link> tab. A verified domain
          belongs to one project at most.
        </p>
        {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}
        {linked.length > 0 ? (
          <ul aria-label="Attached domains" className="mb-4 divide-y divide-slate-200 rounded-md border border-slate-200">
            {linked.map((dom) => (
              <li key={dom.id} className="flex flex-wrap items-center justify-between gap-2 px-4 py-2 text-sm">
                <span>
                  <span className="font-mono font-medium">{dom.apex}</span>
                  <span className="ml-2 text-slate-500">attached {utc(dom.linkedAt)}</span>
                </span>
                {canLink && (
                  <form action={unlinkDomainAction}>
                    <input type="hidden" name="tenantId" value={tenant} />
                    <input type="hidden" name="projectId" value={p.id} />
                    <input type="hidden" name="domainId" value={dom.id} />
                    <button aria-label={`Detach ${dom.apex}`} className="rounded-md border border-slate-300 px-3 py-1 text-sm hover:bg-slate-50">
                      Detach
                    </button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-4 text-sm text-slate-600">No domain is attached to {p.name}.</p>
        )}
        {canLink ? (
          linkable.length > 0 ? (
            <form action={linkDomainAction} className="flex flex-wrap items-end gap-3">
              <input type="hidden" name="tenantId" value={tenant} />
              <input type="hidden" name="projectId" value={p.id} />
              <label className="text-sm">
                <span className="mb-1 block text-slate-600">Verified domain</span>
                <select name="domainId" className="rounded-md border border-slate-300 px-3 py-1.5 font-mono text-sm">
                  {linkable.map((dom) => <option key={dom.id} value={dom.id}>{dom.apex}</option>)}
                </select>
              </label>
              <button className="rounded-md bg-slate-950 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800">Attach domain</button>
            </form>
          ) : (
            <p className="text-sm text-slate-600">
              No verified domain is free to attach. A domain is verified when the security scan proves you control it (a DNS TXT
              record). Workspace owners and admins see the workspace&apos;s unattached domains here.
            </p>
          )
        ) : (
          <p className="text-sm text-slate-500">Only the project&apos;s owners and admins can attach or detach a domain.</p>
        )}
      </section>

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
