import { payingAccount } from "@supahound/core/billing/policy";
import { getBilling } from "@supahound/core/db/billing";
import { getClosure, isClosedNow } from "@supahound/core/db/closure";
import { listConnectionsWithProjects } from "@supahound/core/db/repo";
import { NotAMemberError, withTenantForUser } from "@supahound/core/db/user";
import { tenantId as parseTenantId } from "@supahound/core/tenancy/scope";
import Link from "next/link";
import { notFound, redirect } from "next/navigation";
import { Connections } from "../../../../components/Connections";
import { Notice } from "../../../../components/Shell";
import { mode } from "../../../../lib/billing";
import { canClose, canDisconnect, daysLeft, disconnectedNotice, MESSAGES, settingsPath, ymd } from "../../../../lib/dataControls";
import { withPool } from "../../../../lib/db";
import { requireUser } from "../../../../lib/supabase";
import { reopenAction } from "./actions";

// A closed workspace whose paid period has ended (decision 037). Every other workspace page sends
// its members here. Before the purge the owner can reopen it, and owners and admins can still
// disconnect Supabase. After the purge it says what was deleted and what is kept.

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
      if (!closure) return { state: "open" as const };
      if (!isClosedNow(closure, new Date())) return { state: "closing" as const };
      const [t] = await tx.query<{ name: string }>("SELECT name FROM supahound.tenants WHERE id = $1", [tenant]);
      return {
        state: "closed" as const, role, closure, name: t!.name, paying: payingAccount(await getBilling(tx)),
        connections: canDisconnect(role) && !closure.purgedAt ? await listConnectionsWithProjects(tx) : [],
      };
    }),
  ).catch((err: unknown) => {
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });
  if (data.state === "open") redirect(`/w/${tenant}`);
  if (data.state === "closing") redirect(settingsPath(tenant));

  const query = await searchParams;
  const error = query.error ? MESSAGES[query.error] : undefined;
  const done = disconnectedNotice(query.disconnected, query.removed);
  const { closure } = data;
  const left = daysLeft(closure, new Date());

  return (
    <main className="mx-auto max-w-2xl px-6 py-10">
      <h1 className="mb-6 text-2xl font-semibold">{data.name} is closed</h1>
      {query.closed && <Notice tone="ok">Workspace closed. Supahound stopped watching its projects.</Notice>}
      {error && <Notice tone="error">{error}</Notice>}
      {done && <Notice tone="ok">{done}</Notice>}

      <section className="mb-10 rounded-md border border-slate-200 bg-white p-6">
        <dl className="grid grid-cols-[12rem_1fr] gap-y-2 text-sm">
          <dt className="text-slate-500">Closed on</dt>
          <dd>{ymd(closure.closedAt)}</dd>
          {closure.purgedAt ? (<>
            <dt className="text-slate-500">Logs and history deleted on</dt>
            <dd>{ymd(closure.purgedAt)}</dd>
          </>) : (<>
            <dt className="text-slate-500">Logs and history deleted on</dt>
            <dd>{data.paying ? "Not while the workspace pays" : `${ymd(closure.purgeAfter)} (${left} day${left === 1 ? "" : "s"} left)`}</dd>
          </>)}
        </dl>
        <p className="mt-4 text-sm text-slate-700">
          The workspace record, its billing and payment history and its audit log are kept.
        </p>
        {closure.purgedAt ? null : canClose(data.role) ? (
          <form action={reopenAction} className="mt-6">
            <input type="hidden" name="tenantId" value={tenant} />
            <button className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">Reopen workspace</button>
            <p className="mt-2 text-sm text-slate-500">
              Polling starts again.{mode() === "stripe" ? " The subscription has ended, so the workspace asks for a card again, with no free trial." : ""}
            </p>
          </form>
        ) : (
          <p className="mt-6 text-sm text-slate-600">Only a workspace owner can reopen it.</p>
        )}
      </section>

      {data.connections.length > 0 && (
        <Connections tenant={tenant} connections={data.connections} canDisconnect confirming={query.disconnect} back="closed" paying={data.paying} canReconnect={false} />
      )}

      <p className="text-sm">
        <Link href="/app" className="underline">Your workspaces</Link>
      </p>
    </main>
  );
}
