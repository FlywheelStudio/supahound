import { getClosure, KEEP_RECORDS_YEARS } from "@supahound/core/db/closure";
import { listConnectionsWithProjects } from "@supahound/core/db/repo";
import { NotAMemberError, withTenantForUser } from "@supahound/core/db/user";
import { tenantId as parseTenantId } from "@supahound/core/tenancy/scope";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Connections } from "../../../../components/Connections";
import { Notice } from "../../../../components/Shell";
import { mode } from "../../../../lib/billing";
import { canClose, canDisconnect, daysLeft, disconnectedNotice, MESSAGES, ymd } from "../../../../lib/dataControls";
import { withPool } from "../../../../lib/db";
import { requireUser } from "../../../../lib/supabase";
import { reopenAction } from "./actions";

// A closed workspace (decision 037). Every other workspace page sends its members here until the
// purge. The owner can reopen it; owners and admins can still disconnect Supabase, which deletes
// the sealed token at once instead of at the purge.

export default async function ClosedWorkspace({
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
      const closure = await getClosure(tx);
      if (!closure) return null;
      const [t] = await tx.query<{ name: string }>("SELECT name FROM supahound.tenants WHERE id = $1", [tenant]);
      return { role, closure, name: t!.name, connections: canDisconnect(role) ? await listConnectionsWithProjects(tx) : [] };
    }),
  ).catch((err: unknown) => {
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });
  if (!data) redirect(`/w/${tenant}`);

  const query = await searchParams;
  const error = query.error ? MESSAGES[query.error] : undefined;
  const done = disconnectedNotice(query.disconnected, query.removed);
  const left = daysLeft(data.closure, new Date());

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="mb-6 text-2xl font-semibold">{data.name} is closed</h1>
      {query.closed && <Notice tone="ok">Workspace closed. Supahound stopped watching its projects.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}

      <section className="mb-10 rounded-md border border-slate-200 bg-white p-6">
        <dl className="grid grid-cols-[10rem_1fr] gap-y-2 text-sm">
          <dt className="text-slate-500">Closed on</dt>
          <dd>{ymd(data.closure.closedAt)}</dd>
          <dt className="text-slate-500">Data deleted on</dt>
          <dd>{ymd(data.closure.purgeAfter)} ({left} day{left === 1 ? "" : "s"} left)</dd>
        </dl>
        <p className="mt-4 text-sm text-slate-700">
          On that date Supahound deletes all of this workspace&apos;s data. It keeps only the billing record and any
          security-scan consent, for {KEEP_RECORDS_YEARS} years, for tax and legal reasons.
        </p>
        {canClose(data.role) ? (
          <form action={reopenAction} className="mt-6">
            <input type="hidden" name="tenantId" value={tenant} />
            <button className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">Reopen workspace</button>
            <p className="mt-2 text-sm text-slate-500">
              Polling starts again.{mode() === "stripe" ? " The subscription was canceled, so the workspace may ask for a card again." : ""}
            </p>
          </form>
        ) : (
          <p className="mt-6 text-sm text-slate-600">Only a workspace owner can reopen it.</p>
        )}
      </section>

      {canDisconnect(data.role) && (
        <Connections tenant={tenant} connections={data.connections} canDisconnect confirming={query.disconnect} back="closed" />
      )}

      <p className="text-sm">
        <Link href="/app" className="underline">Your workspaces</Link>
      </p>
    </main>
  );
}
