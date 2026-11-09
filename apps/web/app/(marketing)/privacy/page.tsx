import { Breadcrumbs, PageHead, Sections } from "../../../components/marketing/Blocks";
import { JsonLd } from "../../../components/marketing/JsonLd";
import { PRIVACY } from "../../../content/legal";
import { LEGAL } from "../../../content/site";
import { breadcrumbLd, pageMetadata } from "../../../lib/seo";

const PATH = "/privacy";
const crumbs = [{ name: "Home", path: "/" }, { name: "Privacy policy", path: PATH }];

export const metadata = pageMetadata({
  title: "Privacy policy",
  description: "How Supahound, by Flywheel Studio LLC, collects, uses and protects your data and your users' log data. Read-only access, zero-retention AI.",
  path: PATH,
});

export default function Page() {
  return (
    <>
      <JsonLd data={breadcrumbLd(crumbs)} />
      <Breadcrumbs items={crumbs} />
      <PageHead h1="Privacy policy" intro="This policy explains what personal data Supahound collects, how we use it and the choices you have. In short: read-only access to your Supabase org, no raw log rows stored, no data sold, and zero-retention AI summaries." />
      <p className="mt-3 text-sm text-slate-500">Effective <time dateTime={LEGAL.effective}>{LEGAL.effective}</time></p>
      <div className="mt-10"><Sections sections={PRIVACY} /></div>
    </>
  );
}
