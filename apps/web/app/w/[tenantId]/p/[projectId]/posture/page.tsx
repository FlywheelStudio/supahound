import { listPublicTables } from "@supahound/core/db/detectionSettings";
import { getPostureScan, postureView } from "@supahound/core/db/posture";
import { anonReadableTables, countBySeverity } from "@supahound/core/posture/findings";
import { fixPrompt } from "@supahound/core/posture/fix";
import { Notice, SeverityBadge, Shell } from "../../../../../../components/Shell";
import { mode } from "../../../../../../lib/billing";
import { ACCEPTED_LABEL, canMarkPublic, publicNoticeFrom, publicStatus, WRITES_OPEN_TEXT } from "../../../../../../lib/detectionSettings";
import { utc } from "../../../../../../lib/nav";
import {
  canScan, countsText, graphqlHiddenNote, isPending, postureState, scanNoticeFrom, SOURCE_LABEL, sourceNotes, stateText,
} from "../../../../../../lib/posture";
import { loadProjectPage } from "../../../../../../lib/projectPage";
import { markPublicAction, scanNowAction, unmarkPublicAction } from "./actions";

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
    view: await postureView(tx, p.id),
    marks: await listPublicTables(tx, p.id),
  }));
  const { tenant, project: p } = d;
  const { scan, view: { findings, hiddenGraphql }, marks } = d.extra;
  const query = await searchParams;
  const notice = scanNoticeFrom(query);
  const publicNotice = publicNoticeFrom(query);
  const state = postureState(scan);
  const notes = sourceNotes(scan);
  const graphqlNote = state.kind === "scanned" ? graphqlHiddenNote(hiddenGraphql.length) : null;
  // Intentionally public tables (issue #160, decision 045).
  const publicTables = new Set(marks.map((m) => m.table));
  const readable = [...anonReadableTables(findings).keys()].filter((t) => !publicTables.has(t)).sort();
  const canMark = canMarkPublic(d.projectRole);

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
                {countsText(countBySeverity(findings, publicTables))}
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
            const status = publicStatus(f, publicTables);
            return (
              <li key={f.id} className={`rounded-md border border-slate-200 p-4 ${status === "accepted" ? "bg-slate-50" : "bg-white"}`}>
                <div className="flex flex-wrap items-center gap-3">
                  <SeverityBadge severity={f.severity} />
                  <span className="font-medium">{fix.title}</span>
                  <span className="font-mono text-sm text-slate-700">{object}</span>
                  {status === "accepted" && (
                    <span className="rounded bg-emerald-100 px-2 py-0.5 text-xs font-medium text-emerald-900">{ACCEPTED_LABEL}</span>
                  )}
                  <span className="ml-auto text-xs text-slate-500">{SOURCE_LABEL[f.source]}</span>
                </div>
                <p className="mt-2 text-sm text-slate-700">{fix.explanation}</p>
                {status === "writes_open" && <p className="mt-2 text-sm text-amber-900">{WRITES_OPEN_TEXT}</p>}
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
      {graphqlNote && <p aria-label="Hidden GraphQL findings" className="mt-4 text-sm text-slate-600">{graphqlNote}</p>}

      <section id="public-tables" aria-labelledby="public-heading" className="mt-10 rounded-md border border-slate-200 bg-white p-6">
        <h2 id="public-heading" className="mb-2 font-semibold">Intentionally public tables</h2>
        <p className="mb-4 text-sm text-slate-700">
          Some tables are meant to be read by anyone, such as a price list or a country lookup. Mark one intentionally public
          and Supahound stops alerting on anonymous reads of it from the next poll, and shows its read findings as accepted.
          Findings that let anyone change the table stay open.
        </p>
        {publicNotice && <Notice tone={publicNotice.tone}>{publicNotice.text}</Notice>}
        {marks.length > 0 ? (
          <ul aria-label="Tables marked intentionally public" className="mb-4 divide-y divide-slate-200 rounded-md border border-slate-200">
            {marks.map((m) => (
              <li key={m.table} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                <span className="font-mono">public.{m.table}</span>
                <span className="text-slate-500">marked {utc(m.markedAt)}</span>
                {canMark && (
                  <form action={unmarkPublicAction} className="ml-auto">
                    <input type="hidden" name="tenantId" value={tenant} />
                    <input type="hidden" name="projectId" value={p.id} />
                    <input type="hidden" name="table" value={m.table} />
                    <button aria-label={`Unmark public.${m.table}`} className="rounded-md border border-slate-300 px-3 py-1 font-medium hover:bg-slate-50">Unmark</button>
                  </form>
                )}
              </li>
            ))}
          </ul>
        ) : (
          <p className="mb-4 text-sm text-slate-600">No table is marked intentionally public.</p>
        )}
        {canMark ? (
          readable.length > 0 && (
            <ul aria-label="Tables anyone can read" className="divide-y divide-slate-200 rounded-md border border-slate-200">
              {readable.map((t) => (
                <li key={t} className="flex flex-wrap items-center gap-3 px-4 py-3 text-sm">
                  <span className="font-mono">public.{t}</span>
                  <span className="text-slate-500">anyone with the anon key can read every row</span>
                  <form action={markPublicAction} className="ml-auto">
                    <input type="hidden" name="tenantId" value={tenant} />
                    <input type="hidden" name="projectId" value={p.id} />
                    <input type="hidden" name="table" value={t} />
                    <button aria-label={`Mark public.${t} intentionally public`} className="rounded-md bg-slate-950 px-3 py-1 font-medium text-white hover:bg-slate-800">
                      Mark intentionally public
                    </button>
                  </form>
                </li>
              ))}
            </ul>
          )
        ) : (
          <p className="text-sm text-slate-500">Only the project&apos;s owners and admins can mark a table intentionally public.</p>
        )}
      </section>
    </Shell>
  );
}
