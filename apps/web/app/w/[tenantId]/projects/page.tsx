import { listConnections, listProjects, type ProjectSummary } from "@supahound/core/db/repo";
import { NotAMemberError } from "@supahound/core/db/user";
import { accessTokenInTx } from "@supahound/core/supabase/credentials";
import { isPickable, listSupabaseProjects, ManagementApiError, type SupabaseProject } from "@supahound/core/supabase/management";
import { OAuthError } from "@supahound/core/supabase/oauth";
import { tenantId as parseTenantId, type ConnectionId } from "@supahound/core/tenancy/scope";
import { env } from "cloudflare:workers";
import Link from "next/link";
import { notFound } from "next/navigation";
import { withPool } from "../../../../lib/db";
import { mode, paidTenant, toBillingIfUnpaid } from "../../../../lib/billing";
import { oauthClient, vault } from "../../../../lib/oauth";
import { requireUser } from "../../../../lib/supabase";
import { removeProjectAction, watchProjectsAction } from "./actions";
import { Notice, Shell } from "../../../../components/Shell";
import { projectPath } from "../../../../lib/nav";
import { projectTiers } from "@supahound/core/db/billing";

const ERRORS: Record<string, string> = {
  none: "Select at least one running project.",
  role: "Only workspace owners and admins can change watched projects.",
  connection: "That Supabase connection is not in this workspace.",
  reconnect: "Supabase refused the request. Reconnect Supabase from the overview, then try again.",
  supabase: "Supabase did not answer. Try again in a minute.",
  mismatch: "The name did not match. Nothing was removed.",
  missing: "That project is not watched in this workspace.",
  alerts_missing: "That project is not watched in this workspace.",
};

type Listing =
  | { connectionId: ConnectionId; label: string; projects: SupabaseProject[]; error: null }
  | { connectionId: ConnectionId; label: string; projects: null; error: "reconnect" | "supabase" };

function statusLabel(p: SupabaseProject): string {
  return (p.status ?? "").toLowerCase().replace(/_/g, " ");
}

export default async function Projects({
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

  // Membership, watched projects and connection tokens in one transaction. Members get no token,
  // so their visit never calls Supabase. The Supabase calls run after the transaction commits.
  const data = await withPool((pool) =>
    paidTenant(pool, user.id, tenant, async (tx, role) => {
      const watched = await listProjects(tx);
      const connections = await listConnections(tx);
      const tokens: { connectionId: ConnectionId; label: string; token: string | null }[] = [];
      if (role !== "member") {
        for (const c of connections) {
          let token: string | null = null;
          try {
            token = await accessTokenInTx(tx, vault(), c.id, oauthClient(), new Date());
          } catch (err) {
            // A failed refresh writes nothing; show "reconnect" for this connection only.
            if (!(err instanceof OAuthError)) throw err;
          }
          tokens.push({ connectionId: c.id, label: c.label, token });
        }
      }
      return { role, watched, tiers: await projectTiers(tx), connections: connections.length, tokens };
    }),
  ).catch((err: unknown) => {
    toBillingIfUnpaid(err);
    if (err instanceof NotAMemberError) notFound();
    throw err;
  });

  const listings: Listing[] = await Promise.all(
    data.tokens.map(async (t): Promise<Listing> => {
      if (t.token === null) return { connectionId: t.connectionId, label: t.label, projects: null, error: "reconnect" };
      try {
        return { connectionId: t.connectionId, label: t.label, projects: await listSupabaseProjects(t.token, { baseUrl: env.SUPABASE_API_URL }), error: null };
      } catch (err) {
        const error = err instanceof ManagementApiError && err.needsReconnect ? "reconnect" : "supabase";
        return { connectionId: t.connectionId, label: t.label, projects: null, error };
      }
    }),
  );

  const query = await searchParams;
  const canEdit = data.role !== "member";
  const watchedRefs = new Set(data.watched.map((p) => p.supabaseRef));
  const removing: ProjectSummary | undefined = canEdit && query.remove ? data.watched.find((p) => p.id === query.remove) : undefined;
  const notice = query.added
    ? { tone: "ok", text: query.added === "0" ? "Those projects are already watched." : `Watching ${query.added} new project${query.added === "1" ? "" : "s"}. The first poll runs within a few minutes.` }
    : query.removed
      ? { tone: "ok", text: "Project removed. Its incidents and findings are deleted; its audit log entries are kept." }
      : query.error && ERRORS[query.error]
        ? { tone: "error", text: ERRORS[query.error]! }
        : undefined;

  return (
    <Shell tenant={tenant} role={data.role} projects={data.watched} tiers={data.tiers} billingOn={mode() !== "off"} active={{ kind: "workspace", page: "projects" }}>
      <h1 className="mb-8 text-2xl font-semibold">Projects</h1>

      {notice && <Notice tone={notice.tone as "ok" | "error"}>{notice.text}</Notice>}

      {removing && (
        <section aria-labelledby="remove-heading" className="mb-10 rounded-md border border-red-300 bg-red-50 p-6">
          <h2 id="remove-heading" className="mb-2 font-semibold text-red-900">Remove {removing.name}?</h2>
          <p className="mb-4 text-sm text-red-900">
            Supahound stops watching this project and permanently deletes its incidents, findings and poll history.
            You cannot undo this. Audit log entries for the project are kept. To watch it again later, pick it again;
            history starts from zero.
          </p>
          <form action={removeProjectAction} className="flex flex-wrap items-end gap-3">
            <input type="hidden" name="tenantId" value={tenant} />
            <input type="hidden" name="projectId" value={removing.id} />
            <label className="flex flex-col gap-1 text-sm">
              Type <strong>{removing.name}</strong> to confirm
              <input name="confirmName" autoComplete="off" required className="rounded-md border border-slate-300 bg-white px-3 py-2" />
            </label>
            <button className="rounded-md bg-red-700 px-4 py-2 font-medium text-white hover:bg-red-800">Remove project</button>
            <Link href={`/w/${tenant}/projects`} className="px-2 py-2 text-sm text-slate-700">Cancel</Link>
          </form>
        </section>
      )}

      <section className="mb-10">
        <h2 className="mb-3 font-semibold">Watched</h2>
        {data.watched.length === 0 ? (
          <p className="text-slate-600">No projects watched yet.</p>
        ) : (
          <ul aria-label="Watched projects" className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
            {data.watched.map((p) => (
              <li key={p.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3">
                <span>
                  <Link href={projectPath(tenant, p.id)} className="font-medium hover:underline">{p.name}</Link>
                  <span className="ml-2 font-mono text-xs text-slate-500">{p.supabaseRef}</span>
                </span>
                <span className="flex flex-wrap items-center gap-4">
                  <Link href={projectPath(tenant, p.id, "general")} className="text-sm text-slate-700 hover:text-slate-950">
                    Settings<span className="sr-only"> for {p.name}</span>
                  </Link>
                  {canEdit && (
                    <Link href={`/w/${tenant}/projects?remove=${p.id}`} className="text-sm text-red-700 hover:text-red-900" aria-label={`Remove ${p.name}`}>
                      Remove
                    </Link>
                  )}
                </span>
              </li>
            ))}
          </ul>
        )}
      </section>

      {!canEdit ? (
        <p className="text-slate-600">Only workspace owners and admins can choose projects.</p>
      ) : data.connections === 0 ? (
        <p className="text-slate-600">
          Connect Supabase from the <Link href={`/w/${tenant}`} className="underline">overview</Link> first.
        </p>
      ) : (
        listings.map((l) => (
          <section key={l.connectionId} className="mb-10">
            <h2 className="mb-3 font-semibold">Add from {l.label}</h2>
            {l.error ? (
              <p role="alert" className="text-red-800">{ERRORS[l.error]}</p>
            ) : l.projects.filter((p) => !watchedRefs.has(p.ref)).length === 0 ? (
              <p className="text-slate-600">Every project on this connection is already watched.</p>
            ) : (
              <form action={watchProjectsAction}>
                <input type="hidden" name="tenantId" value={tenant} />
                <input type="hidden" name="connectionId" value={l.connectionId} />
                <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
                  {l.projects.filter((p) => !watchedRefs.has(p.ref)).map((p) => (
                    <li key={p.ref} className="px-4 py-3">
                      <label className={`flex items-center gap-3 ${isPickable(p) ? "" : "text-slate-400"}`}>
                        <input type="checkbox" name="ref" value={p.ref} disabled={!isPickable(p)} />
                        <span className="font-medium">{p.name}</span>
                        <span className="font-mono text-xs">{p.ref}</span>
                        {!isPickable(p) && <span className="text-xs">({statusLabel(p)}; cannot be watched)</span>}
                      </label>
                    </li>
                  ))}
                </ul>
                <button className="mt-4 rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">Watch selected projects</button>
              </form>
            )}
          </section>
        ))
      )}
    </Shell>
  );
}
