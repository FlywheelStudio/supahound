import { countConnections, listOpenIncidents, listProjects } from "@supahound/core/db/repo";
import { NotAMemberError, withTenantForUser } from "@supahound/core/db/user";
import { tenantId as parseTenantId } from "@supahound/core/tenancy/scope";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Checklist } from "../../../components/Checklist";
import { withPool } from "../../../lib/db";
import { currentStep, onboardingSteps } from "../../../lib/onboarding";
import { requireUser } from "../../../lib/supabase";
import { startConnect } from "./actions";

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-700",
};

const NOTICES: Record<string, { tone: "ok" | "error"; text: string }> = {
  connected: { tone: "ok", text: "Supabase connected. Next, choose the projects to watch." },
  connect: { tone: "error", text: "Connecting Supabase failed or the link expired. Try again." },
  consent: { tone: "error", text: "Supabase access was not granted." },
  role: { tone: "error", text: "Only workspace owners and admins can connect Supabase." },
};

export default async function Workspace({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const { tenantId } = await params;
  let tenant;
  try {
    tenant = parseTenantId(tenantId);
  } catch {
    notFound();
  }

  // Membership is checked inside the same transaction that reads the data. A non-member gets
  // the same 404 as a workspace that does not exist.
  const data = await withPool((pool) =>
    withTenantForUser(pool, user.id, tenant, async (tx, role) => ({
      role,
      projects: await listProjects(tx),
      incidents: await listOpenIncidents(tx, 20),
      connections: await countConnections(tx),
    })),
  ).catch((err: unknown) => {
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });

  const query = await searchParams;
  const notice = query.connected ? NOTICES.connected : query.error ? NOTICES[query.error] : undefined;
  const steps = onboardingSteps({ hasWorkspace: true, connections: data.connections, projects: data.projects.length });
  const setupLeft = currentStep(steps);

  return (
    <main className="mx-auto max-w-5xl px-6 py-10">
      <header className="mb-8 flex items-center justify-between">
        <h1 className="text-2xl font-semibold">Overview</h1>
        <form action="/auth/signout" method="post">
          <button className="text-sm text-slate-600 hover:text-slate-950">Sign out</button>
        </form>
      </header>

      {notice && (
        <p role="status" className={`mb-6 rounded-md border p-3 text-sm ${notice.tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}>
          {notice.text}
        </p>
      )}

      {setupLeft && (
        <section className="mb-10 rounded-md border border-slate-200 bg-white p-6">
          <h2 className="mb-4 font-semibold">Finish setup</h2>
          <Checklist steps={steps} />
          {setupLeft.id === "projects" && data.role !== "member" && (
            <Link href={`/w/${tenant}/projects`} className="mt-6 inline-block rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">
              Choose projects
            </Link>
          )}
          {setupLeft.id === "connect" && data.role !== "member" && (
            <form action={startConnect} className="mt-6">
              <input type="hidden" name="tenantId" value={tenant} />
              <button className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">
                Connect Supabase
              </button>
              <p className="mt-2 text-sm text-slate-500">
                Supahound asks for read access to logs, database metadata and the project list only.
              </p>
            </form>
          )}
        </section>
      )}

      <section className="mb-10">
        <h2 className="mb-3 font-semibold">Open incidents</h2>
        {data.incidents.length === 0 ? (
          <p className="text-slate-600">No open incidents.</p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {data.incidents.map((i) => (
              <li key={i.id} className="px-4 py-3">
                <div className="flex items-center gap-3">
                  <span className={`rounded px-2 py-0.5 text-xs font-semibold ${SEVERITY_STYLE[i.severity]}`}>{i.severity}</span>
                  <span className="font-medium">{i.projectName}</span>
                  <span className="text-sm text-slate-500">{i.hits} requests · last {i.lastSeenAt.toISOString()}</span>
                </div>
                {i.summary?.summary && <p className="mt-1 text-sm text-slate-700">{i.summary.summary}</p>}
              </li>
            ))}
          </ul>
        )}
      </section>

      <section>
        <div className="mb-3 flex items-center justify-between">
          <h2 className="font-semibold">Projects</h2>
          {data.connections > 0 && (
            <Link href={`/w/${tenant}/projects`} className="text-sm text-slate-600 hover:text-slate-950">Manage projects</Link>
          )}
        </div>
        {data.projects.length === 0 ? (
          <p className="text-slate-600">
            {data.connections > 0 ? "No projects yet. Choose the projects to watch." : "No projects yet. Connect Supabase to add them."}
          </p>
        ) : (
          <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {data.projects.map((p) => (
              <li key={p.id} className="flex justify-between px-4 py-3">
                <span className="font-medium">{p.name}</span>
                <span className="text-sm text-slate-500">
                  {p.paused ? "paused" : p.lastRunStatus === "unable_to_assess" ? "unable to assess" : p.lastRunStatus ?? "waiting for first poll"}
                  {" · "}{p.openIncidents} open
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>
    </main>
  );
}
