import { accessForAccount } from "@supahound/core/billing/policy";
import { getBilling, projectTiers } from "@supahound/core/db/billing";
import { getClosure, isClosedNow } from "@supahound/core/db/closure";
import { listProjects } from "@supahound/core/db/repo";
import { listSecurityEvents, SECURITY_EVENT_DAYS } from "@supahound/core/db/securityEvents";
import { NotAMemberError, withTenantForUser } from "@supahound/core/db/user";
import { tenantId as parseTenantId } from "@supahound/core/tenancy/scope";
import Link from "../../../../../components/NavLink";
import { notFound, redirect } from "next/navigation";
import { Shell } from "../../../../../components/Shell";
import { mode } from "../../../../../lib/billing";
import { closedPath } from "../../../../../lib/dataControls";
import { withPool } from "../../../../../lib/db";
import { utc } from "../../../../../lib/nav";
import {
  actorLabel, canReadSecurityLog, describeEvent, encodeSecurityCursor, parseSecurityCursor, resultLabel, SECURITY_LOG_PAGE_SIZE,
  securityLogPath,
} from "../../../../../lib/securityLog";
import { requireUser } from "../../../../../lib/supabase";

// Workspace settings → Security log (issue #138, decision 044): sign-ins, invites, role changes,
// removals, Supabase connections, project changes, closing and data deletion, newest first, 50 to
// a page, for the last 90 days. Workspace owners only: the page says so to anyone else, and RLS
// (owner_read) returns them no rows anyway. Not behind the paid gate, like the rest of settings.

export default async function SecurityLog({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string }>;
  searchParams: Promise<Record<string, string | string[] | undefined>>;
}) {
  const user = await requireUser();
  const { tenantId } = await params;
  let tenant;
  try {
    tenant = parseTenantId(tenantId);
  } catch {
    notFound();
  }
  const after = parseSecurityCursor((await searchParams).before);
  if (after === "invalid") notFound();

  const data = await withPool((pool) =>
    withTenantForUser(pool, user.id, tenant, async (tx, role) => {
      if (isClosedNow(await getClosure(tx), new Date())) return { closed: true as const };
      const access = mode() === "off" ? "full" : accessForAccount(await getBilling(tx));
      const owner = canReadSecurityLog(role);
      return {
        closed: false as const, role, access,
        log: owner ? await listSecurityEvents(tx, { now: new Date(), limit: SECURITY_LOG_PAGE_SIZE, after }) : null,
        projects: access === "blocked" ? [] : await listProjects(tx),
        tiers: access === "blocked" ? [] : await projectTiers(tx),
      };
    }),
  ).catch((err: unknown) => {
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });
  if (data.closed) redirect(closedPath(tenant));
  const base = securityLogPath(tenant);

  const content = (
    <>
      <p className="mb-2 text-sm"><Link href={`/w/${tenant}/settings`} className="text-slate-600 hover:text-slate-950">Workspace settings</Link></p>
      <h1 className="mb-1 text-2xl font-semibold">Security log</h1>
      {data.log === null ? (
        <p className="text-slate-600">Only a workspace owner can see the security log.</p>
      ) : (
        <>
          <p className="mb-6 text-sm text-slate-600">
            Sign-ins, invites, role changes, Supabase connections, project changes and data deletion in this workspace from the last{" "}
            {SECURITY_EVENT_DAYS} days, newest first. Refused attempts are listed too.
          </p>
          {data.log.events.length === 0 ? (
            <p className="text-slate-600">{after ? "No older events." : `No events in the last ${SECURITY_EVENT_DAYS} days.`}</p>
          ) : (
            <ul aria-label="Security events" className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
              {data.log.events.map((e) => (
                <li key={e.id} className="px-4 py-3 text-sm">
                  <span className="flex flex-wrap items-center gap-3">
                    <span className={`rounded px-2 py-0.5 text-xs font-medium ${e.result === "success" ? "bg-slate-100 text-slate-700" : "bg-red-100 text-red-800"}`}>
                      {resultLabel(e)}
                    </span>
                    <span className="font-medium text-slate-900">{describeEvent(e)}</span>
                  </span>
                  <span className="mt-1 block text-slate-500">{actorLabel(e)} · {utc(e.createdAt)}</span>
                </li>
              ))}
            </ul>
          )}
          <nav aria-label="Pages" className="mt-4 flex gap-4 text-sm">
            {after && <Link href={base} className="text-slate-600 hover:text-slate-950">Newest</Link>}
            {data.log.next && (
              <Link href={`${base}?before=${encodeURIComponent(encodeSecurityCursor(data.log.next))}`} className="text-slate-600 hover:text-slate-950">
                Older events
              </Link>
            )}
          </nav>
        </>
      )}
    </>
  );

  if (data.access === "blocked") {
    return <main className="mx-auto max-w-3xl px-6 py-10">{content}</main>;
  }
  return (
    <Shell tenant={tenant} role={data.role} projects={data.projects} tiers={data.tiers} billingOn={mode() !== "off"} active={{ kind: "workspace", page: "settings" }}>
      <div className="max-w-3xl">{content}</div>
    </Shell>
  );
}
