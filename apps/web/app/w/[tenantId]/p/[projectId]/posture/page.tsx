import { getPostureScan, listPostureFindings } from "@supahound/core/db/posture";
import { countBySeverity } from "@supahound/core/posture/findings";
import { fixPrompt } from "@supahound/core/posture/fix";
import { Notice, SeverityBadge, Shell } from "../../../../../../components/Shell";
import { mode } from "../../../../../../lib/billing";
import {
  canScan, countsText, isPending, postureState, scanNoticeFrom, SOURCE_LABEL, sourceNotes, stateText,
} from "../../../../../../lib/posture";
import { loadProjectPage } from "../../../../../../lib/projectPage";
import { scanNowAction } from "./actions";

// The project's posture (issue #11, decision 038): RLS coverage, open policies, views that skip
// RLS, and Security Advisor lints, each with a fix prompt built from a template and the finding's
// structured fields. Server-rendered; the SQL is selectable with one click.

export default async function ProjectPosture({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const d = await loadProjectPage(params, async (tx, p) => ({
    scan: await getPostureScan(tx, p.id),
    findings: await listPostureFindings(tx, p.id),
  }));
  const { tenant, project: p } = d;
  const { scan, findings } = d.extra;
  const notice = scanNoticeFrom(await searchParams);
  const state = postureState(scan);
  const notes = sourceNotes(scan);

  return (
    <Shell tenant={tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={mode() !== "off"} active={{ kind: "project", project: p, page: "posture" }}>
      <h1 className="mb-2 text-2xl font-semibold">Posture</h1>
      <p className="mb-6 text-sm text-slate-600">
        Supahound checks the tables, views and RLS policies in the public schema of {p.name}, and reads Supabase&apos;s Security
        Advisor. It scans on the first poll, then every day.
      </p>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <section aria-label="Scan status" className="mb-6 rounded-md border border-slate-200 bg-white p-4">
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <p className={`text-sm font-medium ${state.kind === "unable" ? "text-amber-900" : "text-slate-900"}`}>{stateText(state)}</p>
            {state.kind === "scanned" && (
              <p className="mt-1 text-sm text-slate-600">
                {countsText(countBySeverity(findings))}
                {scan?.tablesChecked != null && ` · checked ${scan.tablesChecked} tables, ${scan.viewsChecked ?? 0} views, ${scan.policiesChecked ?? 0} policies`}
              </p>
            )}
          </div>
          {canScan(d.projectRole) ? (
            <form action={scanNowAction}>
              <input type="hidden" name="tenantId" value={tenant} />
              <input type="hidden" name="projectId" value={p.id} />
              <button disabled={isPending(scan)} className="rounded-md bg-slate-950 px-4 py-1.5 text-sm font-medium text-white hover:bg-slate-800 disabled:opacity-50">
                Scan now
              </button>
            </form>
          ) : (
            <p className="text-sm text-slate-500">Only the project&apos;s owners, admins and editors can start a scan.</p>
          )}
        </div>
        {notes.length > 0 && (
          <ul className="mt-3 space-y-1 text-sm text-amber-900">
            {notes.map((n) => <li key={n}>{n}</li>)}
          </ul>
        )}
      </section>

      {findings.length > 0 ? (
        <ul aria-label="Posture findings" className="space-y-4">
          {findings.map((f) => {
            const fix = fixPrompt(f);
            const object = f.schema && f.object ? `${f.schema}.${f.object}` : f.object ?? "Project";
            return (
              <li key={f.id} className="rounded-md border border-slate-200 bg-white p-4">
                <div className="flex flex-wrap items-center gap-3">
                  <SeverityBadge severity={f.severity} />
                  <span className="font-medium">{fix.title}</span>
                  <span className="font-mono text-sm text-slate-700">{object}</span>
                  <span className="ml-auto text-xs text-slate-500">{SOURCE_LABEL[f.source]}</span>
                </div>
                <p className="mt-2 text-sm text-slate-700">{fix.explanation}</p>
                {fix.sql && (
                  <div className="mt-3">
                    <p className="mb-1 text-xs font-medium uppercase tracking-wide text-slate-500">Fix prompt (SQL, review before you run it)</p>
                    <pre aria-label={`Fix SQL for ${object}`} className="select-all overflow-x-auto rounded-md bg-slate-950 p-3 text-xs text-slate-100">{fix.sql}</pre>
                  </div>
                )}
              </li>
            );
          })}
        </ul>
      ) : (
        state.kind === "scanned" && <p className="text-slate-600">No posture findings in the last scan.</p>
      )}
    </Shell>
  );
}
