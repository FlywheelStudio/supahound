import { countConnections, listOpenIncidents, listProjects } from "@guardbase/core/db/repo";
import { NotAMemberError, withTenantForUser } from "@guardbase/core/db/user";
import { tenantId as parseTenantId } from "@guardbase/core/tenancy/scope";
import { notFound } from "next/navigation";
import { Checklist } from "../../../components/Checklist";
import { withPool } from "../../../lib/db";
import { currentStep, onboardingSteps } from "../../../lib/onboarding";
import { requireUser } from "../../../lib/supabase";

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-700",
};

export default async function Workspace({ params }: { params: Promise<{ tenantId: string }> }) {
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

      {setupLeft && (
        <section className="mb-10 rounded-md border border-slate-200 bg-white p-6">
          <h2 className="mb-4 font-semibold">Finish setup</h2>
          <Checklist steps={steps} />
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
        <h2 className="mb-3 font-semibold">Projects</h2>
        {data.projects.length === 0 ? (
          <p className="text-slate-600">No projects yet. Connect Supabase to add them.</p>
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
