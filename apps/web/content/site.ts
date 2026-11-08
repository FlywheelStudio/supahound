// The one source of public URLs and site-wide facts (decision 017). Never use APP_URL here.

export const SITE_URL = "https://supahound.com";
export const SITE_NAME = "Supahound";
export const SITE_TAGLINE = "Know when someone is abusing your Supabase app.";
export const SITE_DESCRIPTION =
  "Supahound watches your Supabase logs for cross-tenant reads, leaked service keys and scraping, and gives you a fix you can paste. Read-only.";
export const SITE_UPDATED = "2026-11-08";

export const SIGN_UP_PATH = "/login";
// Confirm this inbox exists before launch.
export const CONTACT_EMAIL = "hello@flywheel.so";

export const MAKER = { name: "Flywheel", legalName: "Flywheel Studio LLC", url: "https://flywheel.so" } as const;
export const LEGAL = {
  entity: "Flywheel Studio LLC",
  state: "Texas",
  email: "legal@flywheel.so",
  effective: "2026-11-08",
} as const;

export type Plan = {
  id: "free" | "builder" | "agency";
  name: string;
  price: number; // USD per project per month
  priceLabel: string;
  unit: string;
  blurb: string;
  features: string[];
  cta: string;
  highlight?: boolean;
};

// From the PRD pricing table and decision 013. Change prices here only.
export const PLANS: Plan[] = [
  {
    id: "free",
    name: "Free",
    price: 0,
    priceLabel: "$0",
    unit: "forever",
    blurb: "See if you are exposed.",
    features: [
      "Daily posture scan for up to 3 projects",
      "RLS coverage, Security Advisor findings, exposed tables and views",
      "Email alerts and a weekly digest",
      "No credit card",
    ],
    cta: "Start free",
  },
  {
    id: "builder",
    name: "Builder",
    price: 29,
    priceLabel: "$29",
    unit: "per project / month",
    blurb: "Know when you are attacked, within minutes.",
    features: [
      "Everything in Free",
      "All runtime detectors, polled every 1–2 minutes",
      "Cross-tenant reads, service-key misuse, credential stuffing, scraping, tampering",
      "Plain-English incidents with a fix you can paste",
      "Email and signed webhook alerts (Slack, Discord)",
      "30-day incident history",
    ],
    cta: "Start with Builder",
    highlight: true,
  },
  {
    id: "agency",
    name: "Agency",
    price: 19,
    priceLabel: "$19",
    unit: "per project / month, 10-project minimum",
    blurb: "Watch every client app from one place.",
    features: [
      "Everything in Builder",
      "Multi-project dashboard",
      "Client reports",
      "Lower rates at 25+ projects",
    ],
    cta: "Start with Agency",
  },
];

export const NAV = [
  { href: "/pricing", label: "Pricing" },
  { href: "/platforms", label: "Platforms" },
  { href: "/guides", label: "Guides" },
  { href: "/compare", label: "Compare" },
  { href: "/hack-me", label: "Hack me" },
] as const;
