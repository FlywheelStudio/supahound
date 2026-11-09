import type { FeatureId } from "./features";
import type { Faq } from "./types";

export const DETECTORS: { name: string; body: string; feature: FeatureId }[] = [
  { name: "Cross-tenant reads", body: "One signed-in user reads rows that belong to other users or teams. This is the classic broken-RLS leak.", feature: "crossTenant" },
  { name: "Service-key misuse", body: "Your service_role or secret key calls the API from a new network or a browser. That usually means the key leaked.", feature: "serviceKey" },
  { name: "Credential stuffing", body: "Bursts of failed sign-ins across many accounts from a small set of networks.", feature: "credentialStuffing" },
  { name: "Scraping and bulk reads", body: "One actor sends a request your app never sends, such as select=* with no filter on a users table, or pages through a table far deeper than your app does.", feature: "unusualQueries" },
  { name: "Database tampering", body: "A write to a column your app never writes, such as role, is_admin, plan or credits. That is how privilege escalation looks.", feature: "sensitiveWrites" },
];

export const STEPS: { title: string; body: string; feature: FeatureId }[] = [
  { feature: "supabaseConnect", title: "Connect read-only", body: "Sign in with a magic link and connect your Supabase org with OAuth. Supahound asks for three read-only scopes: analytics:read, database:read and projects:read. It never sees your service-role key." },
  { feature: "postureScan", title: "Get a posture scan", body: "Supahound checks RLS coverage, Security Advisor findings, views without security_invoker and newly exposed tables. The scan is free." },
  { feature: "crossTenant", title: "Get told when it happens", body: "On a paid plan, Supahound reads your edge logs every 1–2 minutes, groups suspicious requests into incidents and emails you what happened and the SQL to fix it." },
];

export const HOME_FAQS: Faq[] = [
  {
    q: "What is Supahound?",
    a: "Supahound is abnormal-traffic monitoring for Supabase apps. It reads your project's logs with read-only access, detects abuse such as cross-tenant reads, leaked service keys, credential stuffing and scraping, and tells you in plain English what happened and how to fix it.",
  },
  {
    q: "How is Supahound different from the Supabase Security Advisor?",
    a: "The Security Advisor checks your configuration: it tells you if a table has no RLS. Supahound also watches traffic per actor, so it can tell you that one user is reading other users' rows right now, even when every table has RLS turned on but a policy is wrong.",
  },
  {
    q: "Does Supahound need my service-role key?",
    a: "No. You connect your Supabase org with OAuth and grant three read-only scopes: analytics:read, database:read and projects:read. Supahound stores the OAuth tokens sealed with a per-tenant key and never asks for a service-role or secret key.",
  },
  {
    q: "Does Supahound send my logs to an AI model?",
    a: "No raw logs reach a model. The incident summary model gets only structured features, such as counts, enums and an anonymous actor label, and every call uses zero data retention. If the model fails, Supahound sends template text instead.",
  },
  {
    q: "Which apps does Supahound work with?",
    a: "Any app with a Supabase backend, whether you built it with Lovable, Bolt, v0, Cursor, Claude Code or by hand. Supahound reads the Supabase project, not your frontend code.",
  },
  {
    q: "How much does Supahound cost?",
    a: "The posture scan is free for up to 3 projects. Runtime detection costs $29 per project per month on Builder, or $19 per project per month on Agency with a 10-project minimum.",
  },
];
