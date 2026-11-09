import { Footer } from "../../components/marketing/Footer";
import { Header } from "../../components/marketing/Header";
import { JsonLd } from "../../components/marketing/JsonLd";
import { organizationLd } from "../../lib/seo";

export default function MarketingLayout({ children }: { children: React.ReactNode }) {
  return (
    <>
      <JsonLd data={organizationLd()} />
      <Header />
      <main className="mx-auto max-w-6xl px-4 pt-8 sm:px-6 sm:pt-12">{children}</main>
      <Footer />
    </>
  );
}
