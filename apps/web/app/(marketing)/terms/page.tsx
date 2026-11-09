import { Breadcrumbs, PageHead, Sections } from "../../../components/marketing/Blocks";
import { JsonLd } from "../../../components/marketing/JsonLd";
import { TERMS } from "../../../content/legal";
import { LEGAL } from "../../../content/site";
import { breadcrumbLd, pageMetadata } from "../../../lib/seo";

const PATH = "/terms";
const crumbs = [{ name: "Home", path: "/" }, { name: "Terms and conditions", path: PATH }];

export const metadata = pageMetadata({
  title: "Terms and conditions",
  description: "The terms for using Supahound, operated by Flywheel Studio LLC: plans and billing, hack me scan rules, acceptable use and liability.",
  path: PATH,
});

export default function Page() {
  return (
    <>
      <JsonLd data={breadcrumbLd(crumbs)} />
      <Breadcrumbs items={crumbs} />
      <PageHead h1="Terms and conditions" intro="These terms govern your use of Supahound. They cover your account, the data you connect, the rules for hack me scans, billing, and the limits of what monitoring can promise." />
      <p className="mt-3 text-sm text-slate-500">Effective <time dateTime={LEGAL.effective}>{LEGAL.effective}</time></p>
      <div className="mt-10"><Sections sections={TERMS} /></div>
    </>
  );
}
