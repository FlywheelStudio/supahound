// The one source of public URLs and site-wide facts (decision 017). Never use APP_URL here.
import type { FeatureId } from "./features";

export const SITE_URL = "https://supahound.com";
export const SITE_NAME = "Supahound";
export const SITE_TAGLINE = "Know when someone is abusing your Supabase app.";
export const SITE_DESCRIPTION =
  "Supahound watches your Supabase logs for cross-tenant reads, leaked service keys and scraping, and gives you a fix you can paste. Read-only.";
export const SITE_UPDATED = "2026-11-09";

export const SIGN_UP_PATH = "/login?signup=1";
export const SIGN_IN_PATH = "/login";
export const CONTACT_EMAIL = "hello@flywheel.so";

export const MAKER = { name: "Flywheel", legalName: "Flywheel Studio LLC", url: "https://flywheel.so" } as const;
export const LEGAL = {
  entity: "Flywheel Studio LLC",
  state: "Texas",
  email: CONTACT_EMAIL,
  effective: "2026-11-09",
} as const;

export type Plan = {
  id: "free" | "builder" | "agency";
  name: string;
  price: number; // USD per project per month
  priceLabel: string;
  unit: string;
  blurb: string;
  features: { text: string; feature?: FeatureId }[];
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
      { text: "Daily posture scan for up to 3 projects", feature: "postureScan" },
      { text: "RLS coverage, Security Advisor findings, exposed tables and views", feature: "postureScan" },
      { text: "Email alerts", feature: "emailAlerts" },
      { text: "Weekly digest", feature: "weeklyDigest" },
      { text: "No credit card" },
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
      { text: "Everything in Free" },
      { text: "Cross-tenant read detection, polled every 1–2 minutes", feature: "crossTenant" },
      { text: "Service-key misuse detection", feature: "serviceKey" },
      { text: "Credential stuffing detection", feature: "credentialStuffing" },
      { text: "Scraping and bulk-read detection", feature: "unusualQueries" },
      { text: "Database tampering detection", feature: "sensitiveWrites" },
      { text: "Plain-English incidents with a fix you can paste", feature: "incidentSummaries" },
      { text: "Signed webhook alerts (Slack, Discord)", feature: "webhookAlerts" },
      { text: "30-day incident history", feature: "incidentHistory" },
    ],
    cta: "Get early access",
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
      { text: "Everything in Builder" },
      { text: "Multi-project dashboard", feature: "agencyDashboard" },
      { text: "Client reports", feature: "clientReports" },
      { text: "Lower rates at 25+ projects", feature: "paidPlans" },
    ],
    cta: "Get early access",
  },
];

export const NAV = [
  { href: "/pricing", label: "Pricing" },
  { href: "/platforms", label: "Platforms" },
  { href: "/guides", label: "Guides" },
  { href: "/compare", label: "Compare" },
  { href: "/hack-me", label: "Hack me" },
] as const;
