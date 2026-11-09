// What the public site may call live (decision 021). Every feature not yet in production shows
// "Coming soon". The PR that ships a feature flips its status to "live" here; the issue number
// says which PR that is. Issue numbers are for the team only and never render.

export type FeatureStatus = "live" | "soon";
export type Feature = { name: string; status: FeatureStatus; issues: number[] };

export const FEATURES = {
  signUp: { name: "Magic-link sign-up", status: "live", issues: [] },
  supabaseConnect: { name: "Read-only Supabase connect and project picker", status: "soon", issues: [4, 9] },
  postureScan: { name: "Daily posture scan", status: "soon", issues: [11] },
  crossTenant: { name: "Cross-tenant read detection", status: "soon", issues: [5] },
  serviceKey: { name: "Service-key misuse detection", status: "soon", issues: [5] },
  credentialStuffing: { name: "Credential stuffing detection", status: "soon", issues: [14] },
  unusualQueries: { name: "Scraping and bulk-read detection (query fingerprinting)", status: "soon", issues: [12] },
  sensitiveWrites: { name: "Database tampering detection (sensitive-column writes)", status: "soon", issues: [13] },
  incidentSummaries: { name: "Plain-English incident summaries", status: "soon", issues: [6] },
  emailAlerts: { name: "Email alerts", status: "soon", issues: [16] },
  webhookAlerts: { name: "Signed webhook alerts", status: "soon", issues: [17] },
  weeklyDigest: { name: "Weekly digest", status: "soon", issues: [22] },
  incidentHistory: { name: "30-day incident history", status: "soon", issues: [44] },
  agencyDashboard: { name: "Multi-project dashboard", status: "soon", issues: [23] },
  clientReports: { name: "Client reports", status: "soon", issues: [31] },
  paidPlans: { name: "Paid plans and billing", status: "soon", issues: [25] },
  hackMeScan: { name: "Hack me external scan", status: "soon", issues: [42] },
  dataControls: { name: "Data controls: retention, deletion, disconnect", status: "soon", issues: [43] },
} as const satisfies Record<string, Feature>;

export type FeatureId = keyof typeof FEATURES;

export const isLive = (id: FeatureId) => FEATURES[id].status === "live";
export const anySoon = () => Object.values(FEATURES).some((f) => f.status === "soon");
