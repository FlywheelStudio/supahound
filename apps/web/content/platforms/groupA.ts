// Written from the platform research. See content/platforms.ts.
import type { Platform } from "../types";

const CHECKED = "2026-11-09";

// Shared SQL and shell snippets. Prose stays unique per platform; code may repeat.
const RLS_OFF =
  "-- Tables in public without RLS. This must return no rows.\nselect c.relname\nfrom pg_class c\njoin pg_namespace n on n.oid = c.relnamespace\nwhere n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;";

const ALWAYS_TRUE =
  "-- Policies that pass for every row.\nselect tablename, policyname, cmd, roles\nfrom pg_policies\nwhere schemaname = 'public'\n  and (qual = 'true' or with_check = 'true');";

const VIEWS =
  "-- Views in public and their options.\n-- A view without security_invoker=true (or =on) runs as its owner and skips RLS.\nselect c.relname, c.reloptions\nfrom pg_class c\njoin pg_namespace n on n.oid = c.relnamespace\nwhere n.nspname = 'public' and c.relkind = 'v';";

const ownerPolicies = (table: string) =>
  `alter table public.${table} enable row level security;\n\ncreate policy "${table}: owner reads" on public.${table}\n  for select to authenticated\n  using ((select auth.uid()) = user_id);\n\ncreate policy "${table}: owner inserts" on public.${table}\n  for insert to authenticated\n  with check ((select auth.uid()) = user_id);\n\ncreate policy "${table}: owner updates" on public.${table}\n  for update to authenticated\n  using ((select auth.uid()) = user_id)\n  with check ((select auth.uid()) = user_id);`;

const testAsUser = (table: string) =>
  `begin;\nset local role authenticated;\nselect set_config('request.jwt.claims', '{"sub":"00000000-0000-0000-0000-000000000001","role":"authenticated"}', true);\nselect count(*) from public.${table};  -- only this user's rows\nrollback;`;

const grepSecrets = (paths: string) =>
  `# Look for a secret key before you deploy. This must print nothing.\ngrep -rnE "sb_secret_|service_role" ${paths} 2>/dev/null`;

const VERIFY_JWT = "# Functions that anyone can call without a signed-in user.\ngrep -n \"verify_jwt = false\" supabase/config.toml";

export const groupA: Platform[] = [
  // ---------------------------------------------------------------------------------------------
  {
    slug: "supabase",
    name: "Supabase",
    url: "https://supabase.com",
    kind: "backend",
    integration: "native",
    oneLine: "Open-source Postgres backend with Auth, a generated REST API and Edge Functions.",
    landing: {
      title: "Supabase security monitoring and abuse detection",
      description:
        "Monitor a Supabase project for cross-tenant reads, leaked secret keys, credential stuffing, scraping and tables exposed without RLS.",
      h1: "Supabase security monitoring: catch abuse in your project's traffic",
      intro:
        "An attacker needs no exploit to read a Supabase table without RLS: Supabase's own lint says anyone with the project URL can create, read, update and delete its rows. Supahound connects with read-only OAuth, runs a free daily posture scan of RLS and Security Advisor findings, and on paid plans reads your edge logs every 1–2 minutes to flag abuse per actor.",
      risks: [
        {
          title: "Cross-tenant reads through a wrong RLS policy",
          detail:
            "RLS is only as strict as its policies. A policy that never compares the row's owner with the caller lets every signed-in user read every row. Security Advisor lint 0024 flags permissive policies, but a policy can pass the lint and still check the wrong column.",
        },
        {
          title: "A leaked secret or service_role key",
          detail:
            "Secret keys (sb_secret_) map to service_role, which has BYPASSRLS. Supabase rejects a secret key sent from a browser with HTTP 401 by checking the User-Agent, so a key copied into a script or a server still works. Legacy service_role JWT keys are deprecated by the end of 2026.",
        },
        {
          title: "Credential stuffing on Supabase Auth",
          detail:
            "The publishable key is safe to expose, so anyone can send sign-in requests to your project with it. An attacker replays leaked email and password lists against Auth, and each match is a taken-over account with that user's RLS rights.",
        },
        {
          title: "Scraping through the REST API",
          detail:
            "On existing projects, new public tables grant anon and authenticated full table privileges unless you revoke them. Any client that holds the public key can page through every row a policy allows, and Escape.tech found anonymous Supabase JWTs in front-end bundles.",
        },
        {
          title: "Tables and views exposed without RLS",
          detail:
            "Tables made in the Table Editor get RLS automatically; tables made with SQL or migrations do not. Views are created as security definer and skip RLS unless set to security_invoker=on. Lints 0013 and 0010 flag both at level ERROR.",
        },
      ],
      howSupahoundHelps: [
        "The free daily posture scan covers up to 3 projects: RLS coverage, Security Advisor findings, views without security_invoker and newly exposed tables.",
        "The cross-tenant read detector flags an actor whose reads cross tenant boundaries, from the first day.",
        "The service-key detector flags a secret or service_role key used from a new network or from a browser.",
        "The credential-stuffing and database-tampering detectors alert from day one. The scraping and bulk-export detector learns each project's traffic for 7 days first.",
        "Each finding joins an incident with a plain-English summary and a paste-ready SQL fix, sent by email or signed webhook and kept for 30 days.",
      ],
      faqs: [
        {
          q: "Does Supabase have built-in security monitoring?",
          a: "Supabase ships the Security Advisor, which lints your schema and configuration. Lint 0013 flags public tables without RLS and lint 0010 flags security definer views. Supahound's free posture scan includes those findings and adds per-actor detection on your edge logs.",
        },
        {
          q: "Does Supahound need my service_role key?",
          a: "No. Supahound never asks for a service_role or secret key. You authorize a Supabase organization through OAuth with two read-only scopes, analytics:read and database:read.",
        },
        {
          q: "Can Supahound block an attack on my Supabase project?",
          a: "No. Supahound detects and does not block. It groups findings into incidents, explains each one in plain English and gives you SQL to paste into your project. You apply the fix.",
        },
        {
          q: "How much does Supabase monitoring with Supahound cost?",
          a: "The posture scan is free for up to 3 projects. Runtime detection costs $29 per project per month on Builder, or $19 per project per month on Agency with a 10-project minimum.",
        },
      ],
    },
    // Supabase has no platform guide page (the Postgres guides cover it). These fields satisfy the type.
    guide: {
      title: "Supabase security checklist for app builders",
      description:
        "Supabase has no separate platform guide here. Read the Postgres guides for RLS, API keys, views and functions in a Supabase project.",
      h1: "Supabase security checklist",
      intro:
        "Turn on RLS for every table in an exposed schema, keep secret keys on servers, set security_invoker on views and require a JWT for Edge Functions. The Postgres guides cover each step with SQL you can run.",
      sections: [],
      faqs: [],
    },
    sources: [
      { label: "Supabase docs: Tables and data", url: "https://supabase.com/docs/guides/database/tables" },
      { label: "Supabase docs: Securing your API", url: "https://supabase.com/docs/guides/api/securing-your-api" },
      { label: "Supabase docs: Row Level Security", url: "https://supabase.com/docs/guides/database/postgres/row-level-security" },
      { label: "Supabase docs: API keys", url: "https://supabase.com/docs/guides/api/api-keys" },
      {
        label: "Supabase docs: Database Advisors (lint 0013)",
        url: "https://supabase.com/docs/guides/database/database-advisors?queryGroups=lint&lint=0013_rls_disabled_in_public",
      },
      { label: "Supabase docs: Function configuration", url: "https://supabase.com/docs/guides/functions/function-configuration" },
      { label: "Escape.tech: vulnerabilities in vibe-coded apps", url: "https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/" },
    ],
    checked: CHECKED,
  },

  // ---------------------------------------------------------------------------------------------
  {
    slug: "lovable",
    name: "Lovable",
    url: "https://lovable.dev",
    kind: "app-builder",
    integration: "native",
    oneLine: "Chat-based builder for full-stack web apps, with a built-in backend on Supabase's open-source foundation.",
    landing: {
      title: "Lovable app security: monitor your Supabase backend",
      description:
        "Lovable ships your Supabase publishable key in the client bundle. Supahound watches the Supabase project behind a Lovable app for abuse and RLS gaps.",
      h1: "Monitor the Supabase backend of your Lovable app",
      intro:
        "A Lovable app calls Supabase from the browser with the key in VITE_SUPABASE_PUBLISHABLE_KEY, so RLS policies are the only thing between a visitor and your tables. Connect the Supabase project behind your Lovable app to Supahound. It checks RLS coverage daily for free and, on paid plans, flags cross-tenant reads, service-key misuse and scraping in the edge logs.",
      risks: [
        {
          title: "Open tables behind the shipped publishable key",
          detail:
            "Lovable's Secrets doc lists VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY as frontend variables embedded in the bundle at build time. A table without RLS, or with a permissive policy, answers anyone who copies them. That is the pattern behind CVE-2025-48757, a CVE tagged disputed; Lovable says each customer is responsible for their app's data.",
        },
        {
          title: "Policies that exist but check the wrong thing",
          detail:
            "Lovable runs automated RLS coverage checks after schema changes. Coverage proves a policy exists, not that it checks ownership. Researcher Matt Palmer said the first Lovable 2.0 security scan only checked whether a policy existed.",
        },
        {
          title: "Edge functions that hold secrets",
          detail:
            "Lovable puts keys such as Stripe, Resend and LOVABLE_API_KEY in edge functions. Its docs note that a client can still call server-side functions, and that code using the service role must check permissions itself.",
        },
        {
          title: "Two Lovable projects on one Supabase project",
          detail:
            "Lovable's docs warn that several Lovable projects connected to the same Supabase project overwrite each other's secrets. A function can end up running with another app's keys.",
        },
        {
          title: "Supabase credentials hardcoded in source",
          detail:
            "TNW reports that in April 2026 a researcher disclosed that a free Lovable account could read other users' public projects through Lovable's API, including hardcoded Supabase credentials. Lovable first said it did not suffer a data breach. A key in source is only as private as the source.",
        },
      ],
      howSupahoundHelps: [
        "The free daily posture scan checks RLS coverage, Security Advisor findings, views without security_invoker and newly exposed tables after each Lovable migration.",
        "The cross-tenant read detector catches a signed-in user reading other users' rows through a policy that passed Lovable's coverage check.",
        "The service-key detector flags the service key used from a new network or a browser, the sign that a key left an edge function or the source.",
        "After 7 days of learning, the scraping detector flags an actor paging through your tables with the publishable key.",
        "The free /hack-me scan checks your published Lovable domain for Supabase keys in public JavaScript, plus headers and TLS, once you prove DNS ownership.",
      ],
      faqs: [
        {
          q: "Is Lovable's security scan enough for a Supabase app?",
          a: "Lovable's Quick scan runs when you open the publish dialog and checks database access rules, leaked-password protection, npm dependencies and MCP. The Deep scan reviews your code on demand. Both run before launch. Supahound watches the traffic after launch, so run both.",
        },
        {
          q: "Does Supahound work with Lovable Cloud?",
          a: "Supahound connects to Supabase organizations you authorize through OAuth. Lovable's docs say Cloud is built on Supabase's open-source foundation, but they do not describe authorizing it as your own Supabase organization. If your app uses your own project through Connectors > Supabase, Supahound can watch it.",
        },
        {
          q: "What was CVE-2025-48757?",
          a: "Researchers scanned 1,645 Lovable projects in March 2025 and found 303 endpoints across 170 projects with inadequate RLS. The CVE record names insufficient RLS in Lovable through 2025-04-15. The record is tagged disputed, and Lovable says each customer is responsible for their app's data.",
        },
        {
          q: "Do I give Supahound the same access I gave Lovable?",
          a: "No. Lovable writes migrations, deploys functions and stores secrets in your project. Supahound only reads: you authorize the organization with analytics:read and database:read, and it never asks for a service-role key.",
        },
      ],
    },
    guide: {
      title: "How to secure a Lovable app with Supabase",
      description:
        "Check RLS, secrets and edge functions in a Lovable + Supabase app: where Lovable stores keys, what its scans check and what to test before you publish.",
      h1: "How to secure a Lovable app's Supabase backend",
      intro:
        "Treat every table as public until a policy proves otherwise. Lovable ships your Supabase URL and publishable key in the client bundle, writes migrations to supabase/migrations/ and deploys edge functions for you. Read each migration for RLS, test policies as a real user, keep secret keys inside edge functions and run Lovable's Quick scan before every publish.",
      sections: [
        {
          heading: "Where does a Lovable app connect to Supabase?",
          paragraphs: [
            "Lovable's built-in backend, Lovable Cloud, is on by default. To use your own Supabase project, connect it from the editor. Lovable then writes SQL migrations, shows them to you for approval and saves them under supabase/migrations/. It also deploys edge functions and stores secrets in the Supabase project.",
          ],
          steps: [
            "Open Connectors > Supabase > Connect Supabase, or Settings > General > External Supabase > Connect.",
            "Sign in to Supabase and authorize Lovable for one organization.",
            "Pick the project. Use one Supabase project per Lovable project: Lovable's docs warn that projects sharing one Supabase project overwrite each other's secrets.",
          ],
        },
        {
          heading: "Which Lovable secrets reach the browser?",
          paragraphs: [
            "VITE_SUPABASE_URL and VITE_SUPABASE_PUBLISHABLE_KEY are frontend variables. Lovable embeds them in the client bundle at build time, which is fine for a publishable key. Keys for Stripe, Resend or LOVABLE_API_KEY belong in edge functions only. Search the build and the source for a secret key before you publish.",
          ],
          code: [{ lang: "bash", code: grepSecrets("dist/ src/"), caption: "Run it in a local copy of the project after a build." }],
        },
        {
          heading: "How do I check the migrations Lovable writes?",
          paragraphs: [
            "Read each migration before you approve it. Every create table needs a matching enable row level security and at least one policy. After you apply the migration, run the catalog query below in the Supabase SQL editor.",
          ],
          code: [
            {
              lang: "bash",
              code: "# Migrations that create a table but never enable RLS.\nfor f in supabase/migrations/*.sql; do\n  grep -qi \"create table\" \"$f\" && ! grep -qi \"enable row level security\" \"$f\" && echo \"$f\"\ndone",
            },
            { lang: "sql", code: RLS_OFF },
            { lang: "sql", code: ownerPolicies("profiles"), caption: "An ownership policy set for a table with a user_id column." },
          ],
        },
        {
          heading: "How do I test that a Lovable policy checks ownership?",
          paragraphs: [
            "Lovable's checks report whether a policy exists. Prove what it allows: switch to the authenticated role inside a transaction, set a user's claims and count rows. Then list any policy that passes every row.",
          ],
          code: [
            { lang: "sql", code: testAsUser("profiles") },
            { lang: "sql", code: ALWAYS_TRUE },
          ],
        },
        {
          heading: "Are Lovable edge functions safe to call from the browser?",
          paragraphs: [
            "Only if each function checks its caller. Lovable's docs say a client can still call server-side functions, and service-role code must check permissions itself. Supabase requires a valid JWT by default; verify_jwt = false lets anyone call the function.",
          ],
          bullets: [
            "Read the caller's JWT and confirm the user may take the action before you touch the service role.",
            "Keep verify_jwt on for every function that is not a public webhook.",
            "Never return a secret, or a raw error that contains one, to the client.",
          ],
          code: [{ lang: "bash", code: VERIFY_JWT }],
        },
        {
          heading: "What should I check before I publish a Lovable app?",
          steps: [
            "Open the publish dialog. The Quick scan runs on its own: database access rules, leaked-password protection, npm dependencies and an MCP check. Fix every finding.",
            "Run the Deep scan to review the application code.",
            "Run the RLS query above and the Supabase Security Advisor on the project.",
            "Add the optional Wiz or Aikido integration if your team uses them.",
            "After you publish, run the free /hack-me scan on your domain to find Supabase keys in public JavaScript.",
          ],
        },
      ],
      faqs: [
        {
          q: "Does Lovable write RLS policies for me?",
          a: "Lovable's docs do not say it writes policies on its own. They tell you to ask Lovable to review your policies and to verify them in Supabase. Lovable does run automated checks for RLS coverage after schema changes.",
        },
        {
          q: "Is the publishable key in my Lovable bundle a leak?",
          a: "No. Publishable keys are meant to be public and map to the anon or authenticated role. Escape.tech found anonymous JWTs in Lovable bundles tied to Supabase PostgREST APIs; the real question is what those keys can read, and RLS answers it.",
        },
        {
          q: "What happened with the Lovable app that exposed 18,697 records?",
          a: "In February 2026 researcher Taimur Khan reported 16 vulnerabilities, 6 critical, in an app on Lovable's Discover page, including inverted access-control logic in auth functions. Lovable said the app had code it did not generate, used a database Lovable did not host, and that acting on its pre-publish scan is the user's choice. Check auth logic too.",
        },
      ],
    },
    sources: [
      { label: "Lovable docs: Supabase integration", url: "https://docs.lovable.dev/integrations/supabase" },
      { label: "Lovable docs: Security", url: "https://docs.lovable.dev/features/security" },
      { label: "Lovable docs: Secrets", url: "https://docs.lovable.dev/features/secrets" },
      { label: "Lovable docs: Security best practices", url: "https://docs.lovable.dev/tips-tricks/security-best-practices" },
      { label: "Matt Palmer: statement on CVE-2025-48757", url: "https://mattpalmer.io/posts/statement-on-CVE-2025-48757/" },
      { label: "CVE record: CVE-2025-48757 (disputed)", url: "https://cveawg.mitre.org/api/cve/CVE-2025-48757" },
      { label: "Escape.tech: vulnerabilities in vibe-coded apps", url: "https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/" },
      { label: "The Register: Lovable-hosted app vulnerabilities (2026-02-27)", url: "https://www.theregister.com/2026/02/27/lovable_app_vulnerabilities" },
      { label: "TNW: Lovable API exposure report", url: "https://thenextweb.com/news/lovable-vibe-coding-security-crisis-exposed" },
      { label: "Supabase docs: Function configuration", url: "https://supabase.com/docs/guides/functions/function-configuration" },
      { label: "Supabase docs: API keys", url: "https://supabase.com/docs/guides/api/api-keys" },
    ],
    checked: CHECKED,
  },

  // ---------------------------------------------------------------------------------------------
  {
    slug: "bolt",
    name: "Bolt.new",
    url: "https://bolt.new",
    kind: "app-builder",
    integration: "native",
    oneLine: "StackBlitz's in-browser AI builder for web and mobile apps, with Bolt Cloud hosting and databases.",
    landing: {
      title: "Bolt.new Supabase security monitoring",
      description:
        "Bolt's docs say any visitor can query your database directly. Supahound watches the Supabase project behind a Bolt.new app for abuse and open policies.",
      h1: "Monitor the Supabase project behind your Bolt.new app",
      intro:
        "Bolt's own docs say anyone who visits your site can send requests to your database directly, without using your site's screens. RLS is the only barrier. If your Bolt app runs on a Supabase project you connected, or on a Bolt Database you claimed into your Supabase organization, Supahound scans its RLS daily for free and flags cross-tenant reads, scraping and service-key misuse.",
      risks: [
        {
          title: "Unknown RLS state on a connected Supabase project",
          detail:
            "Bolt documents that it turns on RLS for the tables it creates in a Bolt Cloud database, and tells you to enable it on tables you add. Its docs do not say what it does for an external Supabase project, so check each table there yourself.",
        },
        {
          title: "Always-true policies",
          detail:
            "Bolt's database security check warns about \"RLS Policy Always True\". A policy that passes for every row lets any visitor change or delete data, even though RLS is on.",
        },
        {
          title: "Direct requests that skip your app's screens",
          detail:
            "Bolt states that any visitor can send requests to your database without using your site's screens. Hiding a button or a page in the UI hides nothing from someone who calls the API.",
        },
        {
          title: "Authentication inside edge functions",
          detail:
            "Bolt's docs call edge functions complex because they connect up services and involve authentication steps. A function that skips the caller check exposes everything its keys can reach.",
        },
        {
          title: "Leaked-password protection after a claim",
          detail:
            "Bolt's docs say leaked-password protection turns off when you claim a Bolt Database into a Supabase account on the Free plan. Users can then sign up with passwords already known from breaches.",
        },
      ],
      howSupahoundHelps: [
        "The free daily posture scan reports RLS coverage and Security Advisor findings, including permissive policies, on your connected or claimed project.",
        "Newly exposed tables show up in the next daily scan, so a table you add without RLS does not stay open for long.",
        "The cross-tenant read detector flags a visitor who uses an always-true policy to read rows that belong to other users.",
        "The database-tampering detector alerts from day one. Visitors changing or deleting data is the harm Bolt's always-true warning describes.",
        "After 7 days of learning, the scraping detector flags an actor who pulls tables in bulk through direct requests.",
      ],
      faqs: [
        {
          q: "Does Supahound monitor a Bolt Database?",
          a: "Supahound monitors projects in a Supabase organization you authorize. A Bolt Database lives in Bolt Cloud until you claim it into your own Supabase organization, which Bolt supports. Once you claim it, or if you started the project on Supabase, connect it to Supahound.",
        },
        {
          q: "Does Bolt's security check cover my Supabase project?",
          a: "Bolt's Database security check scans the Bolt Cloud database with the same checks as the Supabase Security Advisor, and the Security Audit reviews code and database. Bolt's docs do not say whether either applies to a connected external Supabase project, so run the Security Advisor there too.",
        },
        {
          q: "Which Bolt plans can use Supabase?",
          a: "New Bolt projects use a Bolt Database by default. Supabase is an option on the Pro and Teams plans, and one Bolt account connects to one Supabase organization.",
        },
        {
          q: "Can Supahound stop a visitor who queries my Bolt database directly?",
          a: "No. Supahound detects and alerts; it does not sit in the request path. It sends the incident by email or signed webhook with SQL to tighten the policy, and you apply the fix.",
        },
      ],
    },
    guide: {
      title: "How to secure a Bolt.new app on Supabase",
      description:
        "Connect Supabase to Bolt.new safely: turn on RLS for every table, remove always-true policies, check edge functions and run Bolt's security checks.",
      h1: "How to secure a Bolt.new app's Supabase database",
      intro:
        "Assume any visitor can query your Bolt app's database directly, because Bolt's docs say they can. Turn on RLS for every table, replace policies that always return true, make each edge function check its caller and run Bolt's security checks before you publish. On a connected Supabase project, run the Supabase Security Advisor as well.",
      sections: [
        {
          heading: "How do I connect Supabase to Bolt.new?",
          paragraphs: [
            "New Bolt projects use a Bolt Database by default. Supabase is an option on the Pro and Teams plans. You can also claim a Bolt Database into your own Supabase organization later.",
          ],
          steps: [
            "Open Account settings > Applications > Supabase > Connect.",
            "Log in to Supabase and authorize Bolt. One Bolt account connects to one Supabase organization.",
            "Choose Supabase when you start a project, or select or create a Supabase project for an existing one.",
          ],
        },
        {
          heading: "Which tables need RLS in a Bolt project?",
          paragraphs: [
            "All of them. Bolt turns on RLS for the tables it creates in Bolt Cloud and tells you to turn it on for tables you add. For a connected Supabase project its docs say nothing, so list the tables without RLS and fix each one.",
          ],
          code: [
            { lang: "sql", code: RLS_OFF },
            { lang: "sql", code: ownerPolicies("orders") },
          ],
        },
        {
          heading: "How do I find always-true policies?",
          paragraphs: [
            "Bolt's database security check raises \"RLS Policy Always True\" for a policy that lets every row through. On a connected Supabase project, find them with a catalog query and replace each one with a policy that compares the row's owner with the caller.",
          ],
          code: [
            { lang: "sql", code: ALWAYS_TRUE },
            {
              lang: "sql",
              code: "-- Replace an always-true policy with an owner check.\ndrop policy \"orders: anyone updates\" on public.orders;\n\ncreate policy \"orders: owner updates\" on public.orders\n  for update to authenticated\n  using ((select auth.uid()) = user_id)\n  with check ((select auth.uid()) = user_id);",
              caption: "Use the policy names the query returns.",
            },
          ],
        },
        {
          heading: "How should a Bolt edge function check its caller?",
          paragraphs: [
            "Bolt's docs flag edge functions as the complex part of a project because they connect services and handle authentication. Supabase requires a valid JWT for each call by default. Keep that default, and inside the function check that the user may do what the request asks.",
          ],
          bullets: [
            "Leave verify_jwt on unless the function is a webhook that verifies its own signature.",
            "Use the caller's identity from the JWT, never a user ID sent in the request body.",
            "Keep secret keys in the function's environment, never in the frontend.",
          ],
          code: [{ lang: "bash", code: VERIFY_JWT }],
        },
        {
          heading: "What should I run before publishing a Bolt app?",
          steps: [
            "Run the Database security check (all plans). Fix any missing RLS policy and any \"RLS Policy Always True\" warning.",
            "On a paid plan, run the Security Audit from the Publish menu. It reviews code and database for data access, sign-in, key exposure and misuse, up to 30 times per day.",
            "On a connected Supabase project, run the Supabase Security Advisor and the RLS query above.",
            "Search the project for a secret key with the command below.",
          ],
          code: [{ lang: "bash", code: grepSecrets("--exclude-dir=node_modules .") }],
        },
        {
          heading: "What changes when I claim a Bolt Database into Supabase?",
          paragraphs: [
            "The database moves into your own Supabase organization, where you manage it like any other project. On a Supabase Free plan account, Bolt's docs say leaked-password protection turns off, so check your Auth settings after the claim. A claimed project is also one you can authorize Supahound to watch.",
          ],
        },
      ],
      faqs: [
        {
          q: "Does Bolt turn on RLS automatically?",
          a: "For tables Bolt creates in a Bolt Cloud database, yes, per Bolt's docs. For tables you add yourself, you turn it on. For an external Supabase project, Bolt's docs do not say.",
        },
        {
          q: "What does the RLS Policy Always True warning mean?",
          a: "Bolt's database security check raises it when a policy passes for every row. RLS is on, but the policy lets every visitor read, change or delete data. Replace it with a policy that checks the row's owner.",
        },
        {
          q: "How often can I run Bolt's Security Audit?",
          a: "Up to 30 times per day on paid plans, from the Publish menu. It reviews the project's code and database for data-access, sign-in, key-exposure and misuse issues.",
        },
      ],
    },
    sources: [
      { label: "Bolt support: Supabase integration", url: "https://support.bolt.new/integrations/supabase" },
      { label: "Bolt support: Bolt Cloud database", url: "https://support.bolt.new/cloud/database" },
      { label: "Bolt support: Database security", url: "https://support.bolt.new/cloud/database/security" },
      { label: "Bolt support: Security Audit", url: "https://support.bolt.new/building/security" },
      { label: "Supabase docs: Function configuration", url: "https://supabase.com/docs/guides/functions/function-configuration" },
      {
        label: "Supabase docs: Database Advisors",
        url: "https://supabase.com/docs/guides/database/database-advisors?queryGroups=lint&lint=0013_rls_disabled_in_public",
      },
    ],
    checked: CHECKED,
  },

  // ---------------------------------------------------------------------------------------------
  {
    slug: "v0",
    name: "v0",
    url: "https://v0.app",
    kind: "app-builder",
    integration: "native",
    oneLine: "Vercel's AI builder that generates Next.js apps and deploys them to Vercel.",
    landing: {
      title: "v0 app security: monitor your Supabase database",
      description:
        "v0 can run SQL against a Supabase Marketplace integration. Supahound checks the tables it creates for RLS and watches the traffic once your v0 app is live.",
      h1: "Monitor the Supabase database behind your v0 app",
      intro:
        "A v0 app gets Supabase through a one-click Vercel Marketplace integration, and v0 can generate and execute SQL that creates tables. Supabase turns RLS on automatically only for tables made in its Dashboard, so tables from v0's SQL start without it. Supahound's free daily scan finds those tables, and its paid detectors flag service-key misuse and cross-tenant reads in your traffic.",
      risks: [
        {
          title: "Tables from v0-run SQL without RLS",
          detail:
            "For SQL integrations, v0 can create, update and drop tables itself. Supabase enables RLS automatically only for tables made in the Dashboard, and v0's docs do not mention RLS policies.",
        },
        {
          title: "A secret key in a NEXT_PUBLIC_ variable",
          detail:
            "Next.js ships every NEXT_PUBLIC_ variable to the browser. v0 analyzes NEXT_PUBLIC_ usage and warns about exposed tokens, but a Supabase secret key given that prefix still ships to every visitor.",
        },
        {
          title: "Server Actions that skip authorization",
          detail:
            "v0 can move code into Route Handlers or Server Actions. Code there that uses the secret key bypasses RLS, so each handler must confirm who is calling before it reads or writes.",
        },
        {
          title: "Marketplace MCP tools during generation",
          detail:
            "Marketplace integrations can expose remote MCP tools to v0, set to Ask for Approval by default. v0 warns these give it access to tools that read or change external data, which can include your Supabase project.",
        },
      ],
      howSupahoundHelps: [
        "The free daily posture scan reports newly exposed tables and RLS coverage, so a table from v0's SQL shows up the next day.",
        "The service-key detector flags the secret key used from a browser or a new network, the trace a NEXT_PUBLIC_ leak leaves.",
        "The cross-tenant read detector flags a user who reaches other tenants' rows through a policy v0's SQL left too loose.",
        "The free /hack-me scan checks your deployed v0 domain for Supabase keys in public JavaScript after you prove DNS ownership.",
      ],
      faqs: [
        {
          q: "Does v0 add RLS when it creates Supabase tables?",
          a: "v0's docs do not mention RLS. They say v0 can generate and execute SQL to create, update and drop tables. Check every table v0 creates and enable RLS where it is missing.",
        },
        {
          q: "How does v0 protect my Supabase keys?",
          a: "v0's security doc says only NEXT_PUBLIC_ variables reach the browser. v0 analyzes how you use them, warns about exposed tokens and can move code into Route Handlers or Server Actions.",
        },
        {
          q: "Does Supahound work with v0's other databases?",
          a: "No. v0 also offers Neon, Upstash and Vercel Blob through the Marketplace. Supahound monitors Supabase projects only, so it covers a v0 app whose data lives in Supabase.",
        },
      ],
    },
    guide: {
      title: "How to secure a v0 app with Supabase",
      description:
        "Add Supabase to a v0 app, then check the SQL v0 runs for RLS, keep the secret key out of NEXT_PUBLIC_ variables and guard every Server Action.",
      h1: "How to secure a v0 + Supabase app",
      intro:
        "Check every table v0 creates for RLS, keep the Supabase secret key out of any NEXT_PUBLIC_ variable, and make each Server Action or Route Handler that uses the secret key check the user first. v0 adds Supabase through the Vercel Marketplace and can run SQL for you, so review that SQL the way you would review a migration.",
      sections: [
        {
          heading: "How do I add Supabase to a v0 project?",
          steps: [
            "Open Project menu > Settings > Integrations and pick Supabase, or ask for it in the chat.",
            "Let the integration provision the Supabase account. v0 adds the environment variables to the project.",
            "From then on, v0 can generate and execute SQL against the database, including statements that drop tables.",
          ],
        },
        {
          heading: "Which Supabase variables are safe in v0?",
          paragraphs: [
            "Only variables with the NEXT_PUBLIC_ prefix reach the browser. The Supabase URL and publishable key may carry it. The secret key must not. Search the client build for a secret key before each deploy.",
          ],
          code: [{ lang: "bash", code: grepSecrets(".next/static/") }],
        },
        {
          heading: "How do I check the tables v0 created?",
          paragraphs: [
            "Tables made with SQL do not get RLS on their own. Run the query below in the Supabase SQL editor after v0 changes the schema, then add policies to each table it returns.",
          ],
          code: [
            { lang: "sql", code: RLS_OFF },
            { lang: "sql", code: ownerPolicies("tasks") },
          ],
        },
        {
          heading: "How do I guard Server Actions that use the secret key?",
          paragraphs: [
            "The secret key maps to service_role, which skips every policy. A Server Action or Route Handler that holds it is your only check, so write the check first.",
          ],
          bullets: [
            "Read the signed-in user from the session on the server, not from a form field or a URL parameter.",
            "Confirm that user may touch the rows in the request before you run the query.",
            "Prefer the user's own session with the publishable key, so RLS still applies. Use the secret key only for work no user may do.",
            "Keep the secret key in a server-only variable without the NEXT_PUBLIC_ prefix.",
          ],
        },
        {
          heading: "Should v0 use Supabase MCP tools?",
          paragraphs: [
            "Marketplace integrations can expose remote MCP tools to v0, and the default is Ask for Approval. Keep that default. Supabase's MCP guide names prompt injection as the main LLM-specific attack.",
          ],
          bullets: [
            "Scope the connection to one project.",
            "Use read-only mode for anything that runs unattended.",
            "Connect to the production project only when a task needs it.",
          ],
        },
      ],
      faqs: [
        {
          q: "Can v0 drop my Supabase tables?",
          a: "Yes. v0's docs say that for SQL integrations it can generate and execute SQL to create, update and drop tables. Point the integration at a development project while you build, and connect production only when you ship.",
        },
        {
          q: "Where should the Supabase secret key live in a v0 app?",
          a: "In a server-only environment variable without the NEXT_PUBLIC_ prefix, used only by Route Handlers or Server Actions that check the user first.",
        },
        {
          q: "Does v0 scan my database for security issues?",
          a: "v0's docs describe no database security scan. They describe a check of NEXT_PUBLIC_ usage. Run the Supabase Security Advisor, or Supahound's free posture scan, for the database side.",
        },
      ],
    },
    sources: [
      { label: "v0 docs: Databases", url: "https://v0.app/docs/databases" },
      { label: "v0 docs: Security", url: "https://v0.app/docs/security" },
      { label: "v0 docs index", url: "https://v0.app/docs/llms.txt" },
      { label: "Supabase docs: Tables and data", url: "https://supabase.com/docs/guides/database/tables" },
      { label: "Supabase docs: MCP server", url: "https://supabase.com/docs/guides/getting-started/mcp" },
      { label: "Supabase docs: API keys", url: "https://supabase.com/docs/guides/api/api-keys" },
    ],
    checked: CHECKED,
  },

  // ---------------------------------------------------------------------------------------------
  {
    slug: "softgen",
    name: "Softgen",
    url: "https://softgen.ai",
    kind: "app-builder",
    integration: "native",
    oneLine: "AI web app builder on Next.js, Supabase, Vercel and Stripe that plans, builds and deploys apps.",
    landing: {
      title: "Softgen app security: Supabase abuse monitoring",
      description:
        "Softgen builds on Next.js and Supabase with a service role key in the setup. Supahound flags misuse of that key and open tables in your Softgen app.",
      h1: "Monitor the Supabase project behind your Softgen app",
      intro:
        "Softgen apps run on Next.js and Supabase, and the own-project setup asks for three variables: the URL, an anon key that Next.js ships to browsers, and SUPABASE_SERVICE_ROLE_KEY. That last key bypasses RLS. Supahound watches the Supabase project you connect for that key showing up from a browser or a new network, and checks every table for RLS each day.",
      risks: [
        {
          title: "A service role key one prefix away from the browser",
          detail:
            "SUPABASE_SERVICE_ROLE_KEY is part of Softgen's documented setup. Renamed with NEXT_PUBLIC_, or imported into a client component, it hands an RLS-bypassing key to every visitor.",
        },
        {
          title: "Tables open to the browser's anon key",
          detail:
            "The setup puts NEXT_PUBLIC_SUPABASE_ANON_KEY in the browser on purpose. Any table without RLS answers that key, for any visitor who reads it from the page.",
        },
        {
          title: "Server routes that trust the service role",
          detail:
            "Server code that holds the service role key skips every policy. Each route that uses it has to decide on its own whether the caller may see the data.",
        },
        {
          title: "No documented security scan",
          detail:
            "Softgen's onboarding lists Row Level Security as built-in data protection, but it does not say Softgen writes policies and it documents no security scan. Finding RLS gaps falls to the Supabase Security Advisor.",
        },
      ],
      howSupahoundHelps: [
        "The service-key detector flags SUPABASE_SERVICE_ROLE_KEY used from a browser or a new network, from day one.",
        "The free daily posture scan adds the check Softgen does not document: RLS coverage, Security Advisor findings, views without security_invoker and newly exposed tables.",
        "The cross-tenant read detector flags a user whose reads cross tenant boundaries through a server route or a loose policy.",
        "After 7 days of learning, the scraping detector flags bulk reads through the anon key.",
        "The free /hack-me scan checks your Softgen domain for Supabase keys in public JavaScript once you prove DNS ownership.",
      ],
      faqs: [
        {
          q: "Does Supahound work with Softgen's managed Supabase?",
          a: "By default Softgen creates a Supabase project and configures the credentials for you. Supahound watches projects in an organization you authorize, and Softgen's docs do not say you can authorize the managed one. If you bring your own project, Supahound can watch it.",
        },
        {
          q: "Does Softgen set up RLS for my tables?",
          a: "Softgen's onboarding page lists Row Level Security under built-in data protection. It does not say Softgen writes the policies. Run a catalog query or the Security Advisor to see which tables have RLS and which policies exist.",
        },
        {
          q: "Is it safe to give Softgen my service role key?",
          a: "The documented setup stores it as SUPABASE_SERVICE_ROLE_KEY. Without the NEXT_PUBLIC_ prefix, Next.js keeps it on the server. Keep that name, never import it into client code, and rotate it if it ever reaches the browser.",
        },
      ],
    },
    guide: {
      title: "How to secure a Softgen app on Supabase",
      description:
        "Set Softgen's three Supabase variables safely, keep the service role key server-only, turn on RLS for every table and check what ships to the browser.",
      h1: "How to secure a Softgen + Supabase app",
      intro:
        "Keep SUPABASE_SERVICE_ROLE_KEY server-only, turn on RLS for every table the anon key can reach, and make each server route that uses the service role key check the caller. Softgen documents no security scan of its own, so run the Supabase Security Advisor and search your build for secret keys before each deploy.",
      sections: [
        {
          heading: "How does Softgen connect to Supabase?",
          paragraphs: [
            "By default Softgen manages the backend: it creates a Supabase project and configures the credentials. Advanced users connect their own Supabase project with three environment variables.",
          ],
          bullets: [
            "NEXT_PUBLIC_SUPABASE_URL: the project URL. Public.",
            "NEXT_PUBLIC_SUPABASE_ANON_KEY: the anon key. Public, and safe only when RLS is right.",
            "SUPABASE_SERVICE_ROLE_KEY: bypasses RLS. Server only. Never add the NEXT_PUBLIC_ prefix.",
          ],
        },
        {
          heading: "Which Softgen variables reach the browser?",
          paragraphs: [
            "Next.js ships every variable that starts with NEXT_PUBLIC_ to the browser. Build the app, then search the client output for a service role or secret key.",
          ],
          code: [{ lang: "bash", code: grepSecrets(".next/static/") }],
        },
        {
          heading: "How do I check RLS in a Softgen project?",
          paragraphs: [
            "Run the first query in the Supabase SQL editor. It lists tables in public without RLS. Enable RLS on each and add policies; the second block shows an ownership set for a table with a user_id column.",
          ],
          code: [
            { lang: "sql", code: RLS_OFF },
            { lang: "sql", code: ownerPolicies("invoices") },
          ],
        },
        {
          heading: "How should Softgen server code use the service role key?",
          bullets: [
            "Use it only in server code: Route Handlers, Server Actions or background jobs.",
            "Check the signed-in user before every query that uses it. The key skips RLS, so the check is all there is.",
            "Prefer the user's session with the anon key when a user reads their own data, so RLS applies.",
            "Rotate the key if it ever appears in a client bundle, a log or a public repo.",
          ],
        },
        {
          heading: "What should I check before deploying a Softgen app?",
          steps: [
            "Run the RLS query above. It must return no rows.",
            "Run the Supabase Security Advisor and fix every ERROR-level finding.",
            "Search the client build for secret keys.",
            "After deploying, run the free /hack-me scan on your domain.",
          ],
        },
      ],
      faqs: [
        {
          q: "Does Softgen have a security scan?",
          a: "Softgen's docs describe none. The Supabase Security Advisor lints your project for public tables without RLS, permissive policies and security definer views, so make it part of each release.",
        },
        {
          q: "What happens to Softgen's anon and service role keys when Supabase retires legacy keys?",
          a: "Supabase is deprecating the legacy anon and service_role JWT keys by the end of 2026. The replacements are publishable keys (sb_publishable_) and secret keys (sb_secret_). Softgen's docs still name the legacy variables, so check them before you switch.",
        },
        {
          q: "Which Softgen variable must never get the NEXT_PUBLIC_ prefix?",
          a: "SUPABASE_SERVICE_ROLE_KEY. With the prefix, Next.js would put a key that ignores every RLS policy into the JavaScript each visitor downloads.",
        },
      ],
    },
    sources: [
      { label: "Softgen", url: "https://softgen.ai" },
      { label: "Softgen Academy: Supabase onboarding", url: "https://academy.softgen.ai/fullstack/supabase/supabase-onboarding" },
      { label: "Supabase docs: API keys", url: "https://supabase.com/docs/guides/api/api-keys" },
      {
        label: "Supabase docs: Database Advisors",
        url: "https://supabase.com/docs/guides/database/database-advisors?queryGroups=lint&lint=0013_rls_disabled_in_public",
      },
    ],
    checked: CHECKED,
  },

  // ---------------------------------------------------------------------------------------------
  {
    slug: "rork",
    name: "Rork",
    url: "https://rork.com",
    kind: "app-builder",
    integration: "native",
    oneLine: "AI builder for native iOS and Android apps, with Rork Cloud backend and App Store publishing.",
    landing: {
      title: "Rork mobile app Supabase security monitoring",
      description:
        "Rork apps ship the Supabase publishable key inside the iOS or Android binary. Supahound watches the Supabase project behind your Rork app for abuse.",
      h1: "Monitor the Supabase backend of your Rork mobile app",
      intro:
        "A Rork app on Supabase carries the publishable key inside the iOS or Android binary, so anyone who unpacks the app can call your tables directly. RLS has to hold on every table. Connect your Supabase project, or a Rork Cloud backend after you transfer it to your Supabase organization, and Supahound scans RLS daily and flags cross-tenant reads and scraping.",
      risks: [
        {
          title: "The publishable key ships in the app binary",
          detail:
            "Rork's manual setup has you paste the Supabase URL and publishable key into Rork, so the key ships in every copy of the mobile app. You cannot recall a binary from users' phones, so every table needs RLS from the first release.",
        },
        {
          title: "Changes go live with no preview",
          detail:
            "Rork's docs say Rork Cloud changes are live immediately, with no preview step. A wrong policy or migration reaches production data the moment it runs.",
        },
        {
          title: "Edge functions with private keys",
          detail:
            "Edge functions that hold private API keys or handle payment webhooks are reachable from the internet. Supabase lets anyone call a function deployed with verify_jwt = false, so each one needs its own caller check.",
        },
        {
          title: "Same keys after a transfer",
          detail:
            "Transferring Rork Cloud to your own Supabase organization keeps the same URL, data and keys. Any key that leaked before the one-way transfer stays valid until you rotate it.",
        },
      ],
      howSupahoundHelps: [
        "The free daily posture scan reports RLS coverage and newly exposed tables, which matters when a Rork Cloud change goes live without a preview.",
        "The cross-tenant read detector flags an app user whose reads cross into other users' rows.",
        "After 7 days of learning, the scraping detector flags someone who took the key from the binary and pages through your tables.",
        "The service-key detector flags a secret key used from a new network, for example after a transfer that kept old keys.",
      ],
      faqs: [
        {
          q: "Can Supahound monitor Rork Cloud?",
          a: "Rork Cloud is in beta and hosted by Rork. Supahound watches projects in a Supabase organization you authorize. Rork lets you transfer Rork Cloud into your own Supabase organization with the same URL, data and keys; after that, connect it to Supahound.",
        },
        {
          q: "Does Rork write RLS policies?",
          a: "Rork Cloud's setup card says it creates the backend before adding tables, RLS policies or Edge Functions, and promises access rules so each user reads and writes only their own data. Rork documents no database security scan, so verify the policies yourself.",
        },
        {
          q: "Does Rork's AI App Store Reviewer check my database?",
          a: "No. It checks your app against App Store guidelines, not who can read your data. Test your RLS policies separately.",
        },
        {
          q: "Does the /hack-me scan work for a Rork app?",
          a: "Only for a website. The free /hack-me scan checks headers, TLS and Supabase keys in public JavaScript on a domain you prove you own. It does not open an iOS or Android binary, so it cannot see the key inside your Rork app.",
        },
      ],
    },
    guide: {
      title: "How to secure a Rork app with Supabase",
      description:
        "Connect Supabase to a Rork mobile app safely: protect every table with RLS, verify edge functions, test changes before they go live and rotate keys.",
      h1: "How to secure a Rork mobile app's Supabase backend",
      intro:
        "Treat the Supabase publishable key in your Rork app as public, because it ships inside the iOS or Android binary. Turn on RLS with ownership policies for every table, make edge functions that hold private keys check their callers, and test policy changes before you apply them, since Rork Cloud changes go live at once.",
      sections: [
        {
          heading: "How do I connect Supabase to a Rork app?",
          paragraphs: [
            "When an app needs data, Rork shows a Create Rork Cloud card with a Connect my Supabase option. Rork also documents Firebase. For Supabase you have three paths.",
          ],
          steps: [
            "Pick Connect my Supabase on the Create Rork Cloud card.",
            "Or ask Rork: \"Add a Supabase backend to my app\".",
            "Or set it up by hand: copy the project's URL and Publishable key from Supabase and paste them into Rork with the prompt \"Connect Supabase\".",
          ],
        },
        {
          heading: "Why must every table have RLS in a Rork app?",
          paragraphs: [
            "The publishable key ships inside the binary, and anyone can extract it. With the key and the URL, a client can call every table the anon and authenticated roles can reach. RLS is what limits each user to their own rows.",
          ],
          code: [
            { lang: "sql", code: RLS_OFF },
            { lang: "sql", code: ownerPolicies("workouts") },
          ],
        },
        {
          heading: "How do I test a policy before it goes live?",
          paragraphs: [
            "Rork Cloud has no preview step, so test in a transaction that rolls back. Create the policy, switch to a user and count rows, then roll back. Nothing persists until you run it for real.",
          ],
          code: [{ lang: "sql", code: testAsUser("workouts") }],
        },
        {
          heading: "How should Rork edge functions handle private keys?",
          paragraphs: [
            "Edge functions are where private API keys and payment webhooks belong, never in the app. Supabase requires a valid JWT for each call by default. A function deployed with verify_jwt = false accepts calls from anyone.",
          ],
          bullets: [
            "Keep verify_jwt on for functions the app calls.",
            "For a payment webhook that must accept calls without a user JWT, verify the provider's signature inside the function.",
            "Keep private keys in the function's secrets, never in the app's code.",
          ],
          code: [{ lang: "bash", code: VERIFY_JWT, caption: "Run it where you keep the project's Supabase config." }],
        },
        {
          heading: "What should I do after transferring Rork Cloud to my Supabase organization?",
          steps: [
            "Note that the transfer is one-way and keeps the same URL, data and keys.",
            "Rotate any secret key that may have been exposed before the transfer.",
            "Run the RLS query above and the Supabase Security Advisor.",
            "Connect the project to Supahound for the daily posture scan.",
          ],
        },
      ],
      faqs: [
        {
          q: "Is the Supabase key inside my Rork app a secret?",
          a: "No. The publishable key maps to the anon or authenticated role and is meant to be public. Never put a secret key into a Rork app, because anything in the binary is readable.",
        },
        {
          q: "Can I use Firebase instead of Supabase with Rork?",
          a: "Rork documents Firebase as well as Supabase and Rork Cloud. Supahound monitors Supabase projects only.",
        },
        {
          q: "Can I undo a Rork Cloud transfer?",
          a: "No. The transfer to your Supabase organization is one-way. Plan key rotation and RLS checks for the day you transfer.",
        },
      ],
    },
    sources: [
      { label: "Rork docs: Supabase", url: "https://docs.rork.com/backend/supabase" },
      { label: "Rork docs: Rork Cloud", url: "https://docs.rork.com/backend/rork-cloud" },
      { label: "Rork docs index", url: "https://docs.rork.com/llms.txt" },
      { label: "Supabase docs: Function configuration", url: "https://supabase.com/docs/guides/functions/function-configuration" },
      { label: "Supabase docs: API keys", url: "https://supabase.com/docs/guides/api/api-keys" },
    ],
    checked: CHECKED,
  },

  // ---------------------------------------------------------------------------------------------
  {
    slug: "same",
    name: "Same",
    url: "https://same.new",
    kind: "app-builder",
    integration: "native",
    oneLine: "AI app builder that builds and deploys full-stack web apps from prompts.",
    landing: {
      title: "Same.new apps: Supabase security monitoring",
      description:
        "Same connects Supabase through MCP and writes your schema from a prompt. Supahound checks those tables for RLS and watches your Same app's traffic.",
      h1: "Monitor the Supabase project behind your Same app",
      intro:
        "Same connects to Supabase through the Supabase MCP server, then creates the project, designs the schema and runs the migrations from your prompts. Its docs do not mention RLS or a security scan, and Supabase does not turn RLS on for tables made with SQL. Supahound's free daily scan finds tables left open, and its paid detectors flag cross-tenant reads, scraping and tampering.",
      risks: [
        {
          title: "A schema written through MCP-run SQL",
          detail:
            "Same designs the schema and runs the migrations through the Supabase MCP server. Tables made that way do not get RLS automatically, and Same's docs do not say it adds RLS.",
        },
        {
          title: "Project-wide agent access",
          detail:
            "The Supabase card in Same's Tools panel authorizes the Supabase MCP server, which gives the agent access across the project. Supabase's MCP guide names prompt injection as the main LLM-specific attack on that kind of access.",
        },
        {
          title: "No scan inside Same",
          detail:
            "Same's docs describe no security scan. Between prompts, nothing in Same reports a table that lost its RLS or a policy that lets everyone in; the Supabase Security Advisor is the check you have.",
        },
        {
          title: "A secret key in client code",
          detail:
            "Same's docs do not say where it puts Supabase keys. A secret or service_role key in client code skips RLS for anyone who reads it, and Supabase's browser block does not stop a script that copied the key.",
        },
      ],
      howSupahoundHelps: [
        "The free daily posture scan reports RLS coverage, Security Advisor findings and newly exposed tables after each prompt that changes the schema.",
        "From day one, the cross-tenant read detector flags a signed-in user whose reads cross into other tenants' rows in a schema Same designed.",
        "The database-tampering detector needs no learning period, so it covers a Same app from the day you connect its project.",
        "If a secret key ends up in client code Same wrote, the service-key detector flags its use from a browser or an unfamiliar network.",
        "After 7 days of learning, the scraping detector flags bulk export of your tables.",
      ],
      faqs: [
        {
          q: "Does Same turn on RLS for the tables it creates?",
          a: "Same's docs do not say. They describe Same creating the project, designing the schema and running migrations, with no mention of RLS. Run a catalog query after each schema change to check.",
        },
        {
          q: "Should I keep the Supabase MCP connection in Same?",
          a: "Same needs it to build the database. Supabase's MCP guide recommends scoping the connection to one project, using read-only mode for unattended routines and connecting to production only when a task needs it.",
        },
        {
          q: "Does Same have its own database?",
          a: "Same documents no built-in database. It connects Supabase or Neon through MCP. Supahound covers the Supabase case.",
        },
      ],
    },
    guide: {
      title: "How to secure a Same.new app with Supabase",
      description:
        "Connect Supabase to Same through MCP safely: scope the connection, turn on RLS for every table Same creates and keep secret keys out of client code.",
      h1: "How to secure a Same.new + Supabase app",
      intro:
        "Enable RLS on every table Same creates, scope its Supabase MCP connection to a single project, and keep the secret key out of client code. Same builds your schema through MCP from prompts and its docs mention no RLS step or security scan, so check the database yourself with a catalog query and the Supabase Security Advisor before you deploy.",
      sections: [
        {
          heading: "How does Same connect to Supabase?",
          steps: [
            "Open the Tools panel and find the Supabase card.",
            "Click Add Supabase and authorize. This connects the Supabase MCP server.",
            "Prompt Same to build. It creates the Supabase project, designs the schema and runs the migrations.",
          ],
        },
        {
          heading: "How do I limit what the Supabase MCP connection can do?",
          paragraphs: ["Supabase's MCP guide names prompt injection as the main LLM-specific attack. Its advice applies to the connection Same uses."],
          bullets: [
            "Scope the connection to one project, not the whole organization.",
            "Use read-only mode for any routine that runs without you watching.",
            "Build against a development project. Connect production only when a task needs it.",
          ],
        },
        {
          heading: "How do I find tables Same created without RLS?",
          paragraphs: ["Run the query in the Supabase SQL editor after each prompt that changes the schema. Enable RLS and add policies for every table it returns."],
          code: [
            { lang: "sql", code: RLS_OFF },
            { lang: "sql", code: ownerPolicies("posts") },
          ],
        },
        {
          heading: "How do I check views in a Same schema?",
          paragraphs: [
            "Postgres creates views as security definer, so a view on an RLS table can return every row. The Security Advisor flags these with lint 0010. List your views, then set security_invoker on each one.",
          ],
          code: [
            { lang: "sql", code: VIEWS },
            { lang: "sql", code: "alter view public.post_feed set (security_invoker = on);", caption: "Use the view names the first query returns." },
          ],
        },
        {
          heading: "What should I check before deploying a Same app?",
          steps: [
            "Run the RLS and view queries above.",
            "Run the Supabase Security Advisor and fix every ERROR-level finding.",
            "Search the source for a secret key with the command below.",
            "After deploying, run the free /hack-me scan on your domain.",
          ],
          code: [{ lang: "bash", code: grepSecrets("--exclude-dir=node_modules .") }],
        },
      ],
      faqs: [
        {
          q: "Can a prompt injection reach my Supabase data through Same?",
          a: "Supabase calls prompt injection the primary LLM-specific attack on MCP connections, and Same's agent works through the Supabase MCP server. Limit the blast radius: one project, read-only for unattended work, production only when needed.",
        },
        {
          q: "Do I need to recheck RLS after every Same prompt?",
          a: "After every prompt that changes the schema, yes. Each one can add tables through SQL, which start without RLS. Supahound's free daily scan also reports newly exposed tables.",
        },
        {
          q: "Where does Same keep the Supabase keys?",
          a: "Same's docs do not say. Search the code before you deploy: a publishable key in client code is expected, a secret key there is a leak.",
        },
      ],
    },
    sources: [
      { label: "Same docs: Supabase integration", url: "https://docs.same.new/integrations/supabase" },
      { label: "Same docs (full text)", url: "https://docs.same.new/llms-full.txt" },
      { label: "Supabase docs: MCP server", url: "https://supabase.com/docs/guides/getting-started/mcp" },
      { label: "Supabase docs: Tables and data", url: "https://supabase.com/docs/guides/database/tables" },
      { label: "Supabase docs: API keys", url: "https://supabase.com/docs/guides/api/api-keys" },
      {
        label: "Supabase docs: Database Advisors",
        url: "https://supabase.com/docs/guides/database/database-advisors?queryGroups=lint&lint=0013_rls_disabled_in_public",
      },
      { label: "Supabase docs: Row Level Security", url: "https://supabase.com/docs/guides/database/postgres/row-level-security" },
    ],
    checked: CHECKED,
  },

  // ---------------------------------------------------------------------------------------------
  {
    slug: "tempo",
    name: "Tempo",
    url: "https://tempo.new",
    kind: "ai-editor",
    integration: "none",
    oneLine: "Desktop AI software factory that turns issues and specs into reviewed pull requests using Claude or Codex.",
    landing: {
      title: "Tempo + Supabase: security monitoring for your app",
      description:
        "Tempo's desktop agents write code and migrations in your repo. If your app runs on Supabase, Supahound checks new tables for RLS and watches traffic.",
      h1: "Monitor the Supabase project behind an app you build with Tempo",
      intro:
        "Tempo today is a desktop app that runs Claude or Codex agents on your repository and turns issues into pull requests. It has no Supabase integration of its own; the Supabase connect flow belonged to Tempo's legacy web editor. If your codebase runs on Supabase, watch for agent migrations that create tables without RLS. Supahound scans for those tables daily and watches live traffic.",
      risks: [
        {
          title: "Apps from the legacy web editor",
          detail:
            "Tempo's retired web editor connected to Supabase and generated the database structure, typed data handlers and real-time updates. No Tempo doc describes RLS for that schema, so those apps run with whatever RLS state it had.",
        },
        {
          title: "Agent-written migrations",
          detail:
            "Tempo's desktop agents can write SQL migrations in your repo. Supabase does not enable RLS on tables created with SQL, so a merged pull request can add an open table.",
        },
        {
          title: "A secret key in a client-exposed variable",
          detail:
            "Tempo works on your existing codebase, whatever framework it uses. An agent that puts a secret or service_role key into a variable your framework ships to the browser gives every visitor a key that skips RLS.",
        },
      ],
      howSupahoundHelps: [
        "The free daily posture scan reports newly exposed tables, so a merged migration without RLS shows up the next day.",
        "The same scan reports RLS coverage, Security Advisor findings and views without security_invoker for schemas the legacy web editor generated.",
        "The service-key detector flags a secret key used from a browser or a new network, the trace an agent-written client variable leaves.",
        "From day one, the cross-tenant read detector flags a user who reads across tenants through a policy a pull request loosened.",
      ],
      faqs: [
        {
          q: "Does Tempo still connect to Supabase?",
          a: "Not in the current product. Tempo's desktop app docs do not mention Supabase. The Supabase connect flow was part of the web editor, which Tempo's migration guide says was wound down.",
        },
        {
          q: "I built my app in Tempo's old web editor. What should I check?",
          a: "Check RLS on every table, the policies on each one and any views. Run a catalog query for tables without RLS and the Supabase Security Advisor, then connect the project to Supahound for the daily posture scan.",
        },
        {
          q: "Does Supahound review Tempo's pull requests?",
          a: "No. Supahound reads your Supabase project, not your repo: a daily posture scan of the schema and, on paid plans, the edge logs. It works whichever editor or agent wrote the code.",
        },
      ],
    },
    guide: {
      title: "How to secure Supabase in a Tempo codebase",
      description:
        "Review Tempo agents' pull requests for Supabase migrations without RLS, audit apps from the legacy web editor and keep secret keys out of client code.",
      h1: "How to secure a Supabase app you build with Tempo",
      intro:
        "Review every pull request a Tempo agent opens for SQL migrations, and reject any that create a table without enabling RLS. Tempo's desktop app has no Supabase integration, so the database rules live in your repo and your Supabase project. If you built the app with Tempo's legacy web editor, audit the generated schema's RLS now.",
      sections: [
        {
          heading: "Does Tempo connect to Supabase today?",
          paragraphs: [
            "No. The current Tempo product is a local desktop app that runs Claude or Codex agents on your repository, and its docs do not mention Supabase. The earlier web editor had a Supabase integration: you authorized your Supabase account, picked a project, and Tempo generated the schema, typed data handlers and real-time updates. Tempo's migration guide says the web editor was wound down.",
          ],
        },
        {
          heading: "What should I look for in a Tempo pull request?",
          bullets: [
            "A create table with no enable row level security in the same migration.",
            "An update policy with using but no with check.",
            "A new view without security_invoker.",
            "A secret or service_role key in client code or a client-exposed variable.",
            "verify_jwt = false on an Edge Function.",
          ],
          code: [
            {
              lang: "bash",
              code: "# Show the RLS-related lines a branch adds to Supabase migrations.\ngit diff origin/main...HEAD -- supabase/migrations/ \\\n  | grep -inE \"create table|enable row level security|create policy|security_invoker\"",
              caption: "Assumes migrations live in supabase/migrations/. Every create table needs a matching enable line.",
            },
          ],
        },
        {
          heading: "How do I audit an app from Tempo's legacy web editor?",
          paragraphs: ["Run these in the Supabase SQL editor. The first lists tables without RLS. The second lists policies that let every row through."],
          code: [
            { lang: "sql", code: RLS_OFF },
            { lang: "sql", code: ALWAYS_TRUE },
            { lang: "sql", code: ownerPolicies("events") },
          ],
        },
        {
          heading: "How do I keep secret keys out of the client?",
          paragraphs: [
            "Search the source and the build output for a secret key on every branch an agent touches. A publishable key in client code is expected. A secret key there is a leak to rotate.",
          ],
          code: [{ lang: "bash", code: grepSecrets("--exclude-dir=node_modules --exclude-dir=.git .") }],
        },
        {
          heading: "What should I run after merging a Tempo pull request?",
          steps: [
            "Apply the migration to a development project first.",
            "Run the RLS query above. It must return no rows.",
            "Run the Supabase Security Advisor.",
            "Let Supahound's daily posture scan confirm no newly exposed tables reached production.",
          ],
        },
      ],
      faqs: [
        {
          q: "Is Tempo's web editor still available?",
          a: "No. Tempo's migration guide says the web editor was wound down, and the current product is a desktop agent app that works on your own repository.",
        },
        {
          q: "Did Tempo's Supabase integration set up RLS?",
          a: "No Tempo doc says it did. Supabase's partner page describes the integration generating the database structure, typed data handlers and real-time updates, with no mention of policies.",
        },
        {
          q: "Which agents does Tempo run?",
          a: "Claude or Codex, locally, against your repository. They turn issues and specs into pull requests, so your review of each pull request is where database security gets checked.",
        },
      ],
    },
    sources: [
      { label: "Tempo docs: Introduction", url: "https://docs.tempo.new/introduction" },
      { label: "Tempo docs: Migration guide", url: "https://docs.tempo.new/guides/migrate" },
      { label: "Tempo docs index", url: "https://docs.tempo.new/llms.txt" },
      { label: "Supabase partners: Tempo", url: "https://supabase.com/partners/catalog/tempo" },
      { label: "Supabase docs: Tables and data", url: "https://supabase.com/docs/guides/database/tables" },
      { label: "Supabase docs: Function configuration", url: "https://supabase.com/docs/guides/functions/function-configuration" },
      { label: "Supabase docs: API keys", url: "https://supabase.com/docs/guides/api/api-keys" },
    ],
    checked: CHECKED,
  },

  // ---------------------------------------------------------------------------------------------
  {
    slug: "replit",
    name: "Replit",
    url: "https://replit.com",
    kind: "app-builder",
    integration: "none",
    oneLine: "Browser IDE and hosting platform whose Agent builds and publishes full-stack apps from prompts.",
    landing: {
      title: "Replit + Supabase: monitor your app's database",
      description:
        "Replit apps use Replit Database by default. If your Replit app connects to your own Supabase project, Supahound watches its traffic and RLS posture.",
      h1: "Monitor the Supabase project behind your Replit app",
      intro:
        "Replit Agent builds apps on Replit Database, a managed PostgreSQL database, by default, and Replit documents no Supabase integration. These pages apply if your Replit app connects to your own Supabase project, for example one you imported from Lovable, Bolt or Base44. Then RLS, key placement and agent access are yours to check, and Supahound watches that project for abuse.",
      risks: [
        {
          title: "Imported code that still calls the old project",
          detail:
            "Replit's import guides say Supabase data is not migrated when you import a Lovable, Bolt or Base44 project. The imported code can still call the original Supabase project with its original keys, so confirm which project it points at.",
        },
        {
          title: "A secret key outside Replit Secrets",
          detail:
            "Replit's security checklist warns against passing secrets to client-side JavaScript. A Supabase secret key in client code skips RLS for every visitor; keep it in Replit Secrets and use it only on the server.",
        },
        {
          title: "An agent holding a production connection string",
          detail:
            "An agent with a Supabase database connection string can run destructive SQL. In July 2025 Replit's agent deleted SaaStr's production database during a code freeze. That was Replit's own database, not Supabase, but the risk carries over.",
        },
        {
          title: "Tables from Agent's SQL without RLS",
          detail:
            "When Agent creates tables in a Supabase project with SQL, they start without RLS, since Supabase enables it automatically only for tables made in its Dashboard.",
        },
      ],
      howSupahoundHelps: [
        "The free daily posture scan reports RLS coverage and newly exposed tables after Agent changes your Supabase schema.",
        "The service-key detector flags a Supabase secret key that left Replit Secrets and now shows up from a browser or a new network.",
        "The database-tampering detector watches your Supabase project from day one, with no learning period.",
        "The cross-tenant read detector flags a user whose reads cross tenant boundaries in code you imported from another builder.",
      ],
      faqs: [
        {
          q: "Does Replit have a Supabase integration?",
          a: "Replit's docs document none. The integrations page lists Replit Database, a generic PostgreSQL connector and other data connectors, and API keys go in Secrets. Supabase appears only in Replit's import guides.",
        },
        {
          q: "Can I use Supahound if I moved my Lovable app to Replit?",
          a: "Yes, if the Supabase project sits in an organization you can authorize. Supahound reads the Supabase project, so it works whichever frontend calls it, including one now hosted on Replit.",
        },
        {
          q: "Does Supahound monitor Replit Database?",
          a: "No. Replit Database is a managed PostgreSQL database run by Replit, not a Supabase project. Supahound monitors Supabase projects only.",
        },
      ],
    },
    guide: {
      title: "How to secure a Replit app on Supabase",
      description:
        "Connect a Replit app to your own Supabase project safely: store keys in Replit Secrets, limit Agent's database access and turn on RLS for every table.",
      h1: "How to secure a Replit app that uses Supabase",
      intro:
        "Store Supabase keys in Replit Secrets, never in client-side JavaScript. Give Agent a development Supabase project rather than your production connection string, and enable RLS on every table it creates. If you imported the app from Lovable, Bolt or Base44, first confirm which Supabase project the code still calls, because Replit does not migrate Supabase data.",
      sections: [
        {
          heading: "How does a Replit app connect to Supabase?",
          paragraphs: [
            "Replit has no documented Supabase integration. Its default is Replit Database, a managed PostgreSQL database included with every Replit App. Replit documents a generic PostgreSQL connector, and API keys go in Secrets; it documents no Supabase setup. To use Supabase, you connect your own project yourself.",
          ],
        },
        {
          heading: "What happens to Supabase when I import a Lovable, Bolt or Base44 project?",
          paragraphs: [
            "Replit's import guides say Supabase data is not migrated. Find out which Supabase project and which keys the imported code still uses before you change anything.",
          ],
          code: [{ lang: "bash", code: "# Where the imported code reaches Supabase.\ngrep -rnE \"supabase\\.co|SUPABASE_\" --exclude-dir=node_modules ." }],
        },
        {
          heading: "Where do Supabase keys go in Replit?",
          paragraphs: [
            "In Replit Secrets. Replit's security checklist warns against passing secrets to client-side JavaScript. The publishable key may reach the browser; the secret key must stay in server code.",
          ],
          code: [{ lang: "bash", code: grepSecrets("--exclude-dir=node_modules --exclude-dir=.git .") }],
        },
        {
          heading: "How do I limit what Replit Agent can do to my Supabase database?",
          bullets: [
            "Give Agent a development Supabase project, not the production connection string.",
            "Remember the SaaStr case: Replit's agent deleted a production database during a code freeze. Replit then announced separate development and production databases; that applies to Replit Database, not to a Supabase project you connect.",
            "Read the SQL Agent proposes before it runs against a database you care about.",
          ],
        },
        {
          heading: "How do I check RLS on tables Agent created?",
          paragraphs: ["Run the query in the Supabase SQL editor. Enable RLS and add policies for every table it lists."],
          code: [
            { lang: "sql", code: RLS_OFF },
            { lang: "sql", code: ownerPolicies("bookings") },
          ],
        },
      ],
      faqs: [
        {
          q: "Does Replit Agent use the Supabase client in the code it writes?",
          a: "Replit's docs do not say. Its security checklist says Agent uses ORMs by default, and no Replit doc covers Supabase client usage. Read the generated code to see how it reaches the database.",
        },
        {
          q: "Was the SaaStr database deletion a Supabase problem?",
          a: "No. It happened on Replit's own database during Jason Lemkin's public trial. Replit announced separate development and production databases and a refund afterward.",
        },
        {
          q: "Does Replit's Security Center check Supabase RLS?",
          a: "Its documented features are dependency scans for known CVEs, which also run on their own, admin options to require a scan or block publishing at a severity, and Auto-Protect patches. It does not document RLS checks, so use the Supabase Security Advisor.",
        },
      ],
    },
    sources: [
      { label: "Replit docs: SQL database", url: "https://docs.replit.com/cloud-services/storage-and-databases/sql-database" },
      { label: "Replit docs: Integrations", url: "https://docs.replit.com/replitai/integrations" },
      { label: "Replit docs: Import from other providers", url: "https://docs.replit.com/build/import-from-providers" },
      { label: "Replit docs: Security checklist", url: "https://docs.replit.com/learn/security-checklist" },
      { label: "Replit docs: Team security", url: "https://docs.replit.com/teams/security" },
      { label: "The Register: Replit responds to SaaStr database deletion", url: "https://www.theregister.com/2025/07/22/replit_saastr_response/" },
      { label: "Supabase docs: Tables and data", url: "https://supabase.com/docs/guides/database/tables" },
    ],
    checked: CHECKED,
  },
];
