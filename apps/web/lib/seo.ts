import type { Metadata } from "next";
import type { Faq } from "../content/types";
import { MAKER, PLANS, SITE_DESCRIPTION, SITE_NAME, SITE_URL } from "../content/site";

export const abs = (path: string) => `${SITE_URL}${path === "/" ? "" : path}`;

// Page metadata with a canonical URL and Open Graph tags. `title` gets the " | Supahound" suffix
// from the root layout's template.
export function pageMetadata(p: { title: string; description: string; path: string; type?: "website" | "article" }): Metadata {
  return {
    title: p.title,
    description: p.description,
    alternates: { canonical: abs(p.path) },
    openGraph: {
      title: p.title,
      description: p.description,
      url: abs(p.path),
      siteName: SITE_NAME,
      type: p.type ?? "website",
      images: [{ url: abs("/og.png"), width: 1200, height: 630, alt: SITE_NAME }],
    },
    twitter: { card: "summary_large_image", title: p.title, description: p.description, images: [abs("/og.png")] },
  };
}

// JSON-LD builders. Keep them pure so tests can check the output.
export const organizationLd = () => ({
  "@context": "https://schema.org",
  "@type": "Organization",
  "@id": `${SITE_URL}/#org`,
  name: SITE_NAME,
  url: SITE_URL,
  logo: abs("/favicon.svg"),
  parentOrganization: { "@type": "Organization", name: MAKER.legalName, url: MAKER.url },
});

export const softwareLd = () => ({
  "@context": "https://schema.org",
  "@type": "SoftwareApplication",
  name: SITE_NAME,
  url: SITE_URL,
  description: SITE_DESCRIPTION,
  applicationCategory: "SecurityApplication",
  operatingSystem: "Web",
  creator: { "@type": "Organization", name: MAKER.legalName, url: MAKER.url },
  offers: PLANS.map((p) => ({
    "@type": "Offer",
    name: p.name,
    price: p.price.toFixed(2),
    priceCurrency: "USD",
    description: `${p.priceLabel} ${p.unit}`,
    url: abs("/pricing"),
  })),
});

export const breadcrumbLd = (items: { name: string; path: string }[]) => ({
  "@context": "https://schema.org",
  "@type": "BreadcrumbList",
  itemListElement: items.map((it, i) => ({ "@type": "ListItem", position: i + 1, name: it.name, item: abs(it.path) })),
});

export const faqLd = (faqs: Faq[]) => ({
  "@context": "https://schema.org",
  "@type": "FAQPage",
  mainEntity: faqs.map((f) => ({ "@type": "Question", name: f.q, acceptedAnswer: { "@type": "Answer", text: f.a } })),
});

export const articleLd = (a: { title: string; description: string; path: string; updated: string }) => ({
  "@context": "https://schema.org",
  "@type": "TechArticle",
  headline: a.title,
  description: a.description,
  url: abs(a.path),
  dateModified: a.updated,
  datePublished: a.updated,
  author: { "@type": "Organization", name: MAKER.legalName, url: MAKER.url },
  publisher: { "@id": `${SITE_URL}/#org` },
});

// JSON inside <script> must not close the tag: escape "<".
export const serializeLd = (data: unknown) => JSON.stringify(data).replace(/</g, "\\u003c");
