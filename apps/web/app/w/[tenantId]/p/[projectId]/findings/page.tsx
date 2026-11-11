import { ComingSoon, Shell } from "../../../../../../components/Shell";
import { mode } from "../../../../../../lib/billing";
import { loadProjectPage } from "../../../../../../lib/projectPage";

// Security scan findings (the hackme.si scan funnel) for one project. A placeholder until issue #100 links scanned domains to
// projects (decision 034).

export default async function ProjectFindings({ params }: { params: Promise<{ tenantId: string; projectId: string }> }) {
  const d = await loadProjectPage(params);
  return (
    <Shell tenant={d.tenant} role={d.role} projects={d.projects} tiers={d.tiers} billingOn={mode() !== "off"} active={{ kind: "project", project: d.project, page: "findings" }}>
      <h1 className="mb-6 text-2xl font-semibold">Security scan</h1>
      <ComingSoon title="Security scan findings">
        <p>
          Attach your app&apos;s domain to {d.project.name}, and this page lists what the security scan finds there: exposed
          keys in client code, public source maps and leak paths, each with the fix.
        </p>
      </ComingSoon>
    </Shell>
  );
}
