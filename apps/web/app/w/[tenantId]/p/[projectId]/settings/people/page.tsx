import { listInvites, listPeople, PROJECT_ROLES } from "@supahound/core/db/people";
import { Notice, Shell } from "../../../../../../../components/Shell";
import { mode } from "../../../../../../../lib/billing";
import { utc } from "../../../../../../../lib/nav";
import { assignableRoles, can, canInviteAs, canManagePerson, noticeFrom, ROLE_HELP, ROLE_LABEL } from "../../../../../../../lib/people";
import { loadProjectPage } from "../../../../../../../lib/projectPage";
import { requireUser } from "../../../../../../../lib/supabase";
import { cancelInviteAction, inviteAction, removePersonAction, resendInviteAction, setRoleAction } from "./actions";

// Project settings → People (issue #24, decision 036): who has which role on this project, and
// invites. Everyone with a role sees the people; owners and admins also see and manage invites.

const WORKSPACE_NOTE: Record<string, string> = { owner: "Workspace owner", admin: "Workspace admin" };

export default async function ProjectPeople({
  params,
  searchParams,
}: {
  params: Promise<{ tenantId: string; projectId: string }>;
  searchParams: Promise<Record<string, string | undefined>>;
}) {
  const user = await requireUser();
  const now = new Date();
  const d = await loadProjectPage(params, async (tx, p, role) => ({
    people: await listPeople(tx, p.id),
    invites: can(role, "manage_people") ? await listInvites(tx, p.id, now) : [],
  }));
  const { tenant, project: p, projectRole: me } = d;
  const { people, invites } = d.extra;
  const manage = can(me, "manage_people");
  const roles = assignableRoles(me);
  const notice = noticeFrom(await searchParams);
  const hidden = (
    <>
      <input type="hidden" name="tenantId" value={tenant} />
      <input type="hidden" name="projectId" value={p.id} />
    </>
  );

  return (
    <Shell tenant={tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={mode() !== "off"} active={{ kind: "project", project: p, page: "people" }}>
      <h1 className="mb-2 text-2xl font-semibold">People</h1>
      <p className="mb-6 text-sm text-slate-700">
        Your role on {p.name}: <strong>{ROLE_LABEL[me]}</strong>. {ROLE_HELP[me]}
      </p>
      {notice && <Notice tone={notice.tone}>{notice.text}</Notice>}

      <section aria-labelledby="people-heading" className="mb-10">
        <h2 id="people-heading" className="mb-3 font-semibold">People on this project</h2>
        <ul aria-label="People" className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
          {people.map((person) => {
            const label = person.email ?? "Address not on file yet";
            const editable = canManagePerson(me, user.id, person);
            return (
              <li key={person.userId} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                <span>
                  <span className="font-medium">{label}</span>
                  {person.userId === user.id && <span className="ml-2 text-slate-500">(you)</span>}
                  {person.source === "workspace" && (
                    <span className="ml-2 text-xs text-slate-500">{WORKSPACE_NOTE[person.workspaceRole]}</span>
                  )}
                </span>
                {editable ? (
                  <span className="flex flex-wrap items-center gap-2">
                    <form action={setRoleAction} className="flex items-center gap-2">
                      {hidden}
                      <input type="hidden" name="userId" value={person.userId} />
                      <select name="role" defaultValue={person.role} aria-label={`Role for ${label}`} className="rounded-md border border-slate-300 bg-white px-2 py-1">
                        {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                      </select>
                      <button className="rounded-md border border-slate-300 px-3 py-1 font-medium hover:bg-slate-50">
                        Save role<span className="sr-only"> for {label}</span>
                      </button>
                    </form>
                    <form action={removePersonAction}>
                      {hidden}
                      <input type="hidden" name="userId" value={person.userId} />
                      <button className="px-2 py-1 text-red-700 hover:text-red-900" aria-label={`Remove ${label}`}>Remove</button>
                    </form>
                  </span>
                ) : (
                  <span className="font-medium">{ROLE_LABEL[person.role]}</span>
                )}
              </li>
            );
          })}
        </ul>
        <p className="mt-2 text-xs text-slate-500">
          Workspace owners and admins have the Owner and Admin role on every project in the workspace.
        </p>
      </section>

      {manage ? (
        <>
          <section aria-labelledby="invite-heading" className="mb-10 rounded-md border border-slate-200 bg-white p-6">
            <h2 id="invite-heading" className="mb-1 font-semibold">Invite someone</h2>
            <p className="mb-4 text-sm text-slate-600">
              They get an email with a link that works once and expires in 7 days. They join {p.name} only.
            </p>
            <form action={inviteAction} className="flex flex-wrap items-end gap-3 text-sm">
              {hidden}
              <span className="flex flex-col gap-1">
                <label htmlFor="invite-email">Email</label>
                <input id="invite-email" name="email" type="email" required autoComplete="off" className="rounded-md border border-slate-300 px-3 py-2" placeholder="colleague@company.com" />
              </span>
              <span className="flex flex-col gap-1">
                <label htmlFor="invite-role">Role</label>
                <select id="invite-role" name="role" defaultValue="viewer" className="rounded-md border border-slate-300 bg-white px-2 py-2">
                  {roles.map((r) => <option key={r} value={r}>{ROLE_LABEL[r]}</option>)}
                </select>
              </span>
              <button className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">Send invite</button>
            </form>
            <dl className="mt-4 grid gap-1 text-xs text-slate-600">
              {PROJECT_ROLES.map((r) => (
                <div key={r}><dt className="inline font-medium">{ROLE_LABEL[r]}:</dt> <dd className="inline">{ROLE_HELP[r]}</dd></div>
              ))}
            </dl>
          </section>

          <section aria-labelledby="invites-heading">
            <h2 id="invites-heading" className="mb-3 font-semibold">Pending invites</h2>
            {invites.length === 0 ? (
              <p className="text-sm text-slate-600">No pending invites.</p>
            ) : (
              <ul aria-label="Pending invites" className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
                {invites.map((i) => (
                  <li key={i.id} className="flex flex-wrap items-center justify-between gap-3 px-4 py-3 text-sm">
                    <span>
                      <span className="font-medium">{i.email}</span>
                      <span className="ml-2 text-slate-600">{ROLE_LABEL[i.role]}</span>
                      <span className={`ml-2 text-xs ${i.expired ? "text-red-700" : "text-slate-500"}`}>
                        {i.expired ? "Expired" : `Expires ${utc(i.expiresAt)}`}
                      </span>
                    </span>
                    {canInviteAs(me, i.role) && (
                      <span className="flex gap-2">
                        <form action={resendInviteAction}>
                          {hidden}
                          <input type="hidden" name="inviteId" value={i.id} />
                          <button className="rounded-md border border-slate-300 px-3 py-1 font-medium hover:bg-slate-50" aria-label={`Resend invite to ${i.email}`}>Resend</button>
                        </form>
                        <form action={cancelInviteAction}>
                          {hidden}
                          <input type="hidden" name="inviteId" value={i.id} />
                          <button className="px-2 py-1 text-red-700 hover:text-red-900" aria-label={`Cancel invite to ${i.email}`}>Cancel</button>
                        </form>
                      </span>
                    )}
                  </li>
                ))}
              </ul>
            )}
          </section>
        </>
      ) : (
        <p className="text-sm text-slate-600">Only the project&apos;s owners and admins can invite people or change roles.</p>
      )}
    </Shell>
  );
}
