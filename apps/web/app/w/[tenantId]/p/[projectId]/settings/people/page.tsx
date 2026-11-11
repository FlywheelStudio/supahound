import { ComingSoon, Shell } from "../../../../../../../components/Shell";
import { mode } from "../../../../../../../lib/billing";
import { loadProjectPage } from "../../../../../../../lib/projectPage";

// Project settings → People. A placeholder until per-project roles and invites ship (issue #24,
// decision 033). Today membership is per workspace, and the page says so.

export default async function ProjectPeople({ params }: { params: Promise<{ tenantId: string; projectId: string }> }) {
  const d = await loadProjectPage(params);
  return (
    <Shell tenant={d.tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={mode() !== "off"} active={{ kind: "project", project: d.project, page: "people" }}>
      <h1 className="mb-6 text-2xl font-semibold">People</h1>
      <p className="mb-6 text-sm text-slate-700">
        Today every member of this workspace can see {d.project.name}. Owners and admins change its settings.
      </p>
      <ComingSoon title="People and roles for each project">
        <p>
          Invite people by email to this project only, as Owner, Admin, Editor or Viewer. Each person sees only the projects
          they belong to.
        </p>
      </ComingSoon>
    </Shell>
  );
}
