import { listWorkspaces } from "@supahound/core/db/user";
import { redirect } from "next/navigation";
import { withPool } from "../../lib/db";
import { requireUser } from "../../lib/supabase";

// Entry after sign-in: no workspace → onboarding; one → straight in; several → pick one.
export default async function AppHome() {
  const user = await requireUser();
  const workspaces = await withPool((pool) => listWorkspaces(pool, user.id));
  if (workspaces.length === 0) redirect("/onboarding");
  if (workspaces.length === 1) redirect(`/w/${workspaces[0]!.tenantId}`);

  return (
    <main className="mx-auto max-w-xl px-6 py-16">
      <h1 className="mb-6 text-2xl font-semibold">Choose a workspace</h1>
      <ul className="divide-y divide-slate-200 rounded-md border border-slate-200 bg-white">
        {workspaces.map((w) => (
          <li key={w.tenantId}>
            <a href={`/w/${w.tenantId}`} className="flex justify-between px-4 py-3 hover:bg-slate-50">
              <span className="font-medium">{w.name}</span>
              <span className="text-sm text-slate-500">{w.role}</span>
            </a>
          </li>
        ))}
      </ul>
    </main>
  );
}
