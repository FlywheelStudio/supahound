import { accessForAccount } from "@supahound/core/billing/policy";
import { getBilling, projectTiers } from "@supahound/core/db/billing";
import { getClosure, KEEP_RECORDS_YEARS, PURGE_AFTER_DAYS } from "@supahound/core/db/closure";
import { listConnectionsWithProjects, listProjects } from "@supahound/core/db/repo";
import { RETENTION_DAYS } from "@supahound/core/db/retention";
import { NotAMemberError, withTenantForUser } from "@supahound/core/db/user";
import { tenantId as parseTenantId } from "@supahound/core/tenancy/scope";
import { env } from "cloudflare:workers";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Connections } from "../../../../components/Connections";
import { Notice, Shell } from "../../../../components/Shell";
import { mode } from "../../../../lib/billing";
import { brandFrom } from "../../../../lib/brand";
import { canClose, canDisconnect, closedPath, disconnectedNotice, MESSAGES } from "../../../../lib/dataControls";
import { withPool } from "../../../../lib/db";
import { requireUser } from "../../../../lib/supabase";
import { closeWorkspaceAction } from "./actions";

// Workspace settings (issue #43, decision 037): Supabase connections with Disconnect, how long
// data is kept, and Close workspace. Not behind the paid gate, so a workspace that does not pay
// can still remove its data; a closed workspace goes to its closed page.

export default async function WorkspaceSettings({
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

  const data = await withPool((pool) =>
    withTenantForUser(pool, user.id, tenant, async (tx, role) => {
      if (await getClosure(tx)) return { closed: true as const };
      const access = mode() === "off" ? "full" : accessForAccount(await getBilling(tx));
      const [t] = await tx.query<{ name: string }>("SELECT name FROM supahound.tenants WHERE id = $1", [tenant]);
      return {
        closed: false as const, role, access, name: t!.name,
        connections: await listConnectionsWithProjects(tx),
        projects: access === "blocked" ? [] : await listProjects(tx),
        tiers: access === "blocked" ? [] : await projectTiers(tx),
      };
    }),
  ).catch((err: unknown) => {
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });
  if (data.closed) redirect(closedPath(tenant));

  const query = await searchParams;
  const error = query.error ? MESSAGES[query.error] : undefined;
  const done = disconnectedNotice(query.disconnected, query.removed);
  const support = brandFrom(env).supportEmail;
  const owner = canClose(data.role);

  const content = (
    <>
      <h1 className="mb-8 text-2xl font-semibold">Workspace settings</h1>
      {error && <Notice tone="error">{error}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}

      <Connections
        tenant={tenant}
        connections={data.connections}
        canDisconnect={canDisconnect(data.role)}
        confirming={query.disconnect}
        back="settings"
      />

      <section aria-labelledby="retention-heading" className="mb-10">
        <h2 id="retention-heading" className="mb-3 font-semibold">How long Supahound keeps data</h2>
        <ul className="list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>Incidents and findings: {RETENTION_DAYS} days after an incident&apos;s last activity. An incident that stays quiet for {RETENTION_DAYS} days is resolved, then deleted.</li>
          <li>Poll history: {RETENTION_DAYS} days. The latest poll of each project stays.</li>
          <li>A closed workspace: all its data is deleted {PURGE_AFTER_DAYS} days after it closes.</li>
        </ul>
      </section>

      <section aria-labelledby="close-heading" className="rounded-md border border-red-300 bg-white p-6">
        <h2 id="close-heading" className="mb-2 font-semibold text-red-900">Close workspace</h2>
        <ul className="mb-4 list-disc space-y-1 pl-5 text-sm text-slate-700">
          <li>Supahound stops watching every project at once.</li>
          {mode() === "stripe" && <li>The subscription is canceled at once. The current period is not refunded.</li>}
          <li>Members can no longer open the workspace. An owner can reopen it within {PURGE_AFTER_DAYS} days.</li>
          <li>
            After {PURGE_AFTER_DAYS} days, Supahound deletes all of the workspace&apos;s data: projects, incidents, findings, poll history,
            audit log, members, invites and Supabase tokens.
          </li>
          <li>
            Supahound keeps only the billing record (Stripe customer and subscription IDs, the accepted terms and their dates) and
            any security-scan consent, for {KEEP_RECORDS_YEARS} years, for tax and legal reasons.
          </li>
          <li>
            Your sign-in account stays, because it may belong to other workspaces.
            {support ? <> To delete it too, email <a href={`mailto:${support}`} className="underline">{support}</a>.</> : null}
          </li>
        </ul>
        {owner ? (
          <form action={closeWorkspaceAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="tenantId" value={tenant} />
            <label className="flex flex-col gap-1 text-sm">
              Type <strong>{data.name}</strong> to confirm
              <input name="confirmName" autoComplete="off" required className="rounded-md border border-slate-300 bg-white px-3 py-2" />
            </label>
            <button className="rounded-md bg-red-700 px-4 py-2 font-medium text-white hover:bg-red-800">Close workspace</button>
          </form>
        ) : (
          <p className="text-sm text-slate-600">Only a workspace owner can close the workspace.</p>
        )}
      </section>
    </>
  );

  // A workspace that does not pay opens only Billing and this page, so the sidebar would bounce.
  if (data.access === "blocked") {
    return (
      <main className="mx-auto max-w-2xl px-6 py-10">
        <p className="mb-6 text-sm"><Link href={`/w/${tenant}/billing`} className="underline">Back to Billing</Link></p>
        {content}
      </main>
    );
  }
  return (
    <Shell tenant={tenant} role={data.role} projects={data.projects} tiers={data.tiers} billingOn={mode() !== "off"} active={{ kind: "workspace", page: "settings" }}>
      <div className="max-w-2xl">{content}</div>
    </Shell>
  );
}
