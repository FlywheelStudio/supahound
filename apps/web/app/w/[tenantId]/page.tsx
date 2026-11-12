import { needsEnterprise, PRICE_LABEL, seatsFor } from "@supahound/core/billing/policy";
import { billedTiers, getBilling, projectTiers } from "@supahound/core/db/billing";
import { getClosure } from "@supahound/core/db/closure";
import { postureSummaries } from "@supahound/core/db/posture";
import { countConnections, listOpenIncidents, listProjects, recordMemberEmail } from "@supahound/core/db/repo";
import { NotAMemberError } from "@supahound/core/db/user";
import { tenantId as parseTenantId } from "@supahound/core/tenancy/scope";
import Link from "next/link";
import { notFound } from "next/navigation";
import { Checklist } from "../../../components/Checklist";
import { Notice, SeverityBadge, Shell } from "../../../components/Shell";
import { incidentPath, projectPath } from "../../../lib/nav";
import { crossTenantNote } from "../../../lib/coverage";
import { postureLine } from "../../../lib/posture";
import { withPool } from "../../../lib/db";
import { mode, paidTenant, syncSeatsAfterChange, toBillingIfUnpaid } from "../../../lib/billing";
import { currentStep, onboardingSteps } from "../../../lib/onboarding";
import { requireUser } from "../../../lib/supabase";
import { startConnect } from "./actions";

const NOTICES: Record<string, { tone: "ok" | "error"; text: string }> = {
  welcome: { tone: "ok", text: "Card confirmed and the hold released. Your 7-day trial has started. Next, connect Supabase." },
  connected: { tone: "ok", text: "Supabase connected. Next, choose the projects to watch." },
  reconnected: { tone: "ok", text: "Supabase reconnected. Its projects and their history are back, and polling has started again." },
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
    paidTenant(pool, user.id, tenant, async (tx, role, access) => ({
      // Alerts go to the address in the verified JWT; copied here, written only when it changed.
      emailRecorded: await recordMemberEmail(tx, user.id, user.email),
      role,
      access,
      billing: await getBilling(tx),
      tiers: await projectTiers(tx),
      projects: await listProjects(tx),
      posture: await postureSummaries(tx),
      incidents: await listOpenIncidents(tx, 20),
      connections: await countConnections(tx),
      closure: await getClosure(tx),
    })).then(async (d) => {
      // The picker syncs seats; this catches a sync that failed after the picker committed. Only
      // workspace owners and admins see every project (decision 036), so only they can spot drift.
      if (d.role === "member") return d;
      const want = seatsFor(billedTiers(d.tiers));
      if (d.billing.seats && (d.billing.seats.starter !== want.starter || d.billing.seats.pro !== want.pro)) {
        await syncSeatsAfterChange(pool, tenant, false);
      }
      return d;
    }),
  ).catch((err: unknown) => {
    toBillingIfUnpaid(err);
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });

  const query = await searchParams;
  const welcome = data.billing.status === "trialing"
    ? NOTICES.welcome
    : { tone: "ok" as const, text: "Card confirmed and the hold released. Your subscription is active. Next, connect Supabase." };
  const notice = query.welcome ? welcome : query.connected ? NOTICES.connected : query.reconnected ? NOTICES.reconnected : query.error ? NOTICES[query.error] : undefined;
  const steps = onboardingSteps({ hasWorkspace: true, hasCard: mode() === "off" ? null : true, connections: data.connections, projects: data.projects.length });
  const setupLeft = currentStep(steps);

  return (
    <Shell tenant={tenant} role={data.role} projects={data.projects} tiers={data.tiers} billingOn={mode() !== "off"} active={{ kind: "workspace", page: "overview" }}>
      <h1 className="mb-8 text-2xl font-semibold">Overview</h1>

      {data.access === "grace" && (
        <p role="alert" className="mb-6 rounded-md border border-red-200 bg-red-50 p-3 text-sm text-red-900">
          Your last payment failed. Stripe will retry it. Update your card in{" "}
          <Link href={`/w/${tenant}/billing`} className="underline">Billing</Link> to keep watching your projects.
        </p>
      )}
      {data.closure && (
        <p role="alert" className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          This workspace closes on {data.closure.accessEndsAt.toISOString().slice(0, 10)}.{" "}
          <Link href={`/w/${tenant}/settings`} className="underline">Workspace settings</Link>
        </p>
      )}
      {data.billing.status === "trialing" && data.billing.trialEnd && (
        <p className="mb-6 rounded-md border border-slate-200 bg-slate-50 p-3 text-sm text-slate-700">
          Your free trial ends on {data.billing.trialEnd.toISOString().slice(0, 10)}.{" "}
          <Link href={`/w/${tenant}/billing`} className="underline">Billing</Link>
        </p>
      )}
      {data.tiers.some((t) => needsEnterprise(t.requests30d)) && (
        <p className="mb-6 rounded-md border border-amber-200 bg-amber-50 p-3 text-sm text-amber-900">
          A project here sends more than 10 million requests a month. It stays on Pro, and we will contact you about Enterprise.
        </p>
      )}
      {notice && (
        <Notice tone={notice.tone}>{notice.text}</Notice>
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
                  <SeverityBadge severity={i.severity} />
                  <Link href={projectPath(tenant, i.projectId)} className="font-medium hover:underline">{i.projectName}</Link>
                  <span className="text-sm text-slate-500">{i.hits} requests · last {i.lastSeenAt.toISOString()}</span>
                  <Link href={incidentPath(tenant, i.projectId, i.id)} className="ml-auto text-sm text-slate-600 hover:text-slate-950">Details</Link>
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
            {data.projects.map((p) => {
              const note = crossTenantNote(p.crossTenant);
              const posture = postureLine(data.posture.get(p.id));
              return (
                <li key={p.id} className="px-4 py-3">
                  <div className="flex justify-between">
                    <Link href={projectPath(tenant, p.id)} className="font-medium hover:underline">{p.name}</Link>
                    <span className="text-sm text-slate-500">
                      {(() => {
                        const t = data.tiers.find((x) => x.id === p.id);
                        if (!t || mode() === "off") return null;
                        const usage = t.requests30d === null ? "usage counted daily" : `${t.requests30d.toLocaleString("en-US")} requests in 30 days`;
                        return `${t.tier === "pro" ? "Pro" : "Starter"} ${PRICE_LABEL[t.tier]}/mo · ${usage} · `;
                      })()}
                      {p.paused ? "Supabase disconnected" : p.lastRunStatus === "unable_to_assess" ? "unable to assess" : p.lastRunStatus ?? "waiting for first poll"}
                      {" · "}{p.openIncidents} open
                    </span>
                  </div>
                  <p className={`mt-1 text-sm ${posture.tone === "warn" ? "text-amber-800" : "text-slate-600"}`}>{posture.text}</p>
                  {note && (
                    <p className={`mt-1 text-sm ${note.tone === "warn" ? "text-amber-800" : "text-slate-600"}`}>{note.text}</p>
                  )}
                </li>
              );
            })}
          </ul>
        )}
      </section>
    </Shell>
  );
}
