// Content shapes for the marketing site. Pages render these; tests check them (test/content.test.ts).

export type Source = { label: string; url: string };
export type Faq = { q: string; a: string };

export type Code = { lang: "sql" | "ts" | "bash" | "text"; code: string; caption?: string };

// A guide section. Headings are phrased as the question a reader (or an answer engine) asks.
export type Section = {
  heading: string;
  paragraphs?: string[];
  bullets?: string[];
  steps?: string[];
  code?: Code[];
};

export type PageMeta = {
  title: string; // <= 60 characters, without the " | Supahound" suffix
  description: string; // <= 160 characters
  h1: string;
  intro: string; // answer-first opening paragraph
};

export type Risk = { title: string; detail: string };

export type Platform = {
  slug: string;
  name: string;
  url: string;
  kind: "app-builder" | "ai-editor" | "backend";
  integration: "native" | "supported" | "none";
  oneLine: string;
  landing: PageMeta & { risks: Risk[]; howSupahoundHelps: string[]; faqs: Faq[] };
  guide: PageMeta & { sections: Section[]; faqs: Faq[] };
  sources: Source[];
  checked: string; // YYYY-MM-DD
};

export type CompareRow = { feature: string; supahound: string; them: string };

export type Competitor = {
  slug: string;
  name: string;
  url: string;
  category: string;
  meta: PageMeta;
  rows: CompareRow[];
  strengths: string[];
  gaps: string[];
  pricing: string;
  bestFor: string; // who should pick the competitor: be honest
  chooseSupahound: string;
  faqs: Faq[];
  sources: Source[];
  checked: string; // YYYY-MM-DD
};

export type Guide = {
  slug: string;
  meta: PageMeta;
  sections: Section[];
  faqs: Faq[];
  related: string[]; // other guide slugs
  updated: string; // YYYY-MM-DD
};
