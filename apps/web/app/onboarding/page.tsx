import { listWorkspaces } from "@guardbase/core/db/user";
import { redirect } from "next/navigation";
import { Checklist } from "../../components/Checklist";
import { withPool } from "../../lib/db";
import { onboardingSteps } from "../../lib/onboarding";
import { requireUser } from "../../lib/supabase";
import { createWorkspaceAction } from "./actions";

export default async function Onboarding({ searchParams }: { searchParams: Promise<Record<string, string | undefined>> }) {
  const user = await requireUser();
  const workspaces = await withPool((pool) => listWorkspaces(pool, user.id));
  if (workspaces.length > 0) redirect(`/w/${workspaces[0]!.tenantId}`);
  const { error } = await searchParams;

  return (
    <main className="mx-auto grid max-w-4xl gap-10 px-6 py-16 md:grid-cols-[1fr_1.2fr]">
      <Checklist steps={onboardingSteps({ hasWorkspace: false, connections: 0, projects: 0 })} />
      <section>
        <h1 className="text-2xl font-semibold">Create your workspace</h1>
        <p className="mt-2 text-slate-600">
          A workspace holds your Supabase connections, projects and alerts. Agencies use one workspace for all
          client projects.
        </p>
        <form action={createWorkspaceAction} className="mt-6 flex flex-col gap-3">
          <label htmlFor="name" className="text-sm font-medium">Workspace name</label>
          <input id="name" name="name" required maxLength={200} placeholder="Acme Studio"
            className="rounded-md border border-slate-300 px-3 py-2" />
          {error && <p role="alert" className="text-sm text-red-700">Enter a name up to 200 characters.</p>}
          <button type="submit" className="rounded-md bg-slate-950 px-4 py-2 font-medium text-white hover:bg-slate-800">
            Create workspace
          </button>
        </form>
        <p className="mt-4 text-sm text-slate-500">Signed in as {user.email}</p>
      </section>
    </main>
  );
}
