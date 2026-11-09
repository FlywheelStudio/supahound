// Competitor comparison pages (/compare/<slug>). Each entry shows its check date and sources.
import type { Competitor } from "./types";

export const competitors: Competitor[] = [
  {
    slug: "supabase-advisors",
    name: "Supabase Advisors",
    url: "https://supabase.com/docs/guides/database/database-advisors",
    category: "Built-in posture check",
    meta: {
      title: "Supahound vs Supabase Advisors: runtime vs posture",
      description:
        "Supabase Advisors lint schema and config, and the Security monitor agent checks failure rates daily. Supahound watches each user's traffic every 1–2 minutes.",
      h1: "Supahound vs Supabase Advisors: schema lints vs per-user traffic detection",
      intro:
        "Supabase Advisors are Supabase's own lint checks for schema, RLS and configuration. Supabase also publishes a Security monitor agent guide: a prompt you run once a day in your own agent. Supahound reads each project's edge logs every 1–2 minutes on paid plans and flags what each user does. Run the Advisors first; Supahound covers the traffic they do not watch.",
    },
    rows: [
      { feature: "Checks schema and RLS configuration?", supahound: "Yes. Free daily posture scan that includes Security Advisor findings.", them: "Yes. Security Advisor runs Supabase's own lints." },
      { feature: "Watches live Supabase traffic?", supahound: "Yes. Reads edge logs every 1–2 minutes on paid plans.", them: "Health Advisor measures error rates from logs. The monitor agent compares API and Auth failure rates." },
      { feature: "Per-user detection?", supahound: "Yes. Detectors run per actor.", them: "Security Advisor does not attribute traffic to users. The agent guide does not describe per-user alerts." },
      { feature: "How often does it check?", supahound: "Every 1–2 minutes on paid plans; posture scan daily.", them: "Advisors on demand. The monitor agent once a day." },
      { feature: "Who runs the alerting?", supahound: "Supahound hosts it: email and signed webhooks, incidents, 30-day history.", them: "You run the agent in your own harness, which stores alert state." },
      { feature: "Needs a service-role key?", supahound: "No. Read-only OAuth.", them: "No. The agent uses read-only MCP." },
    ],
    strengths: [
      "Security Advisor runs deterministic lints from Supabase itself: RLS disabled in public, permissive RLS policies, security definer views, exposed auth.users, sensitive columns and anon-executable security definer functions.",
      "Runs on demand from Studio, the CLI (supabase db advisors), the Management API or the MCP get_advisors tool, with no extra account.",
      "Health Advisor (added 2026-09-18) measures error rates across Auth, Storage, Edge Functions and the Data APIs from logs.",
      "The Security monitor agent guide uses read-only MCP (get_advisors and query_logs), runs daily, and reports new or changed advisor findings and Auth and API failure-rate spikes.",
    ],
    gaps: [
      "Security Advisor checks schema and configuration. It does not attribute traffic to individual users or flag one user reading other users' rows.",
      "The Security monitor agent runs once a day and compares API and Auth failure rates across the last two complete UTC days. Supabase calls a spike \"a review signal, not proof of an attack\".",
      "You set up and maintain the harness that runs the agent and stores its alert state. There is no hosted incident grouping or incident history.",
      "The Advisors docs page does not describe a schedule or email alerts for Security Advisor findings.",
    ],
    pricing:
      "The Advisors are part of the Supabase dashboard and are not priced separately. Supabase plans start at $0 (Free), $25 per month (Pro) and $599 per month (Team). The Security monitor agent is a prompt you run in your own agent, such as Claude Routines, Codex scheduled tasks or Cursor Automations, so it costs what that agent subscription costs.",
    bestFor:
      "first, whatever else you pick: every Supabase team should run the Advisors. If you want a free check and will run your own daily agent, that may be enough without paid monitoring.",
    chooseSupahound:
      "if you want per-user detection of cross-tenant reads, service-key misuse, credential stuffing, scraping and database tampering every 1–2 minutes, with hosted alerts and incident history.",
    faqs: [
      {
        q: "Does Supahound replace the Supabase Security Advisor?",
        a: "No. Supahound's free posture scan includes Security Advisor findings next to RLS coverage, views without security_invoker and newly exposed tables. Keep running the Advisors; they come from Supabase itself.",
      },
      {
        q: "Is the Supabase Security monitor agent enough to catch an attack?",
        a: "It runs once a day and compares API and Auth failure rates across the last two complete UTC days. Supabase itself calls a spike a review signal, not proof of an attack. Supahound checks every 1–2 minutes on paid plans and names the actor behind each finding.",
      },
      {
        q: "What does the Health Advisor measure?",
        a: "Supabase added the Health Advisor on 2026-09-18. It measures error rates across Auth, Storage, Edge Functions and the Data APIs from logs. It is a health signal, not a set of security detectors.",
      },
    ],
    sources: [
      { label: "Supabase docs: Database Advisors", url: "https://supabase.com/docs/guides/database/database-advisors" },
      { label: "Supabase changelog: security", url: "https://supabase.com/changelog?tags=security" },
      { label: "Supabase docs: Security monitor agent", url: "https://supabase.com/docs/guides/observability/automate-with-agents/security" },
      { label: "Supabase pricing", url: "https://supabase.com/pricing" },
    ],
    checked: "2026-11-08",
  },
  {
    slug: "lovable-security-scan",
    name: "Lovable Security Scan",
    url: "https://docs.lovable.dev/features/security",
    category: "Built-in posture check",
    meta: {
      title: "Supahound vs Lovable Security Scan for Supabase apps",
      description:
        "Lovable's security scans review code, dependencies and database rules before you publish. Supahound watches your Supabase traffic after you ship.",
      h1: "Supahound vs Lovable Security Scan: before publish vs after launch",
      intro:
        "Lovable Security Scan is a pair of free scans built into Lovable: a quick scan in the publish dialog and a deep scan of your app code. Supahound reads your Supabase edge logs after launch and flags what each user does. Lovable checks the code you are about to ship; Supahound watches who uses it.",
    },
    rows: [
      { feature: "What does it check?", supahound: "Live Supabase traffic, plus a daily posture scan.", them: "Code, npm dependencies, database access rules and MCP servers." },
      { feature: "Watches live Supabase traffic?", supahound: "Yes. Edge logs every 1–2 minutes on paid plans.", them: "No. The docs describe static analysis, not runtime logs." },
      { feature: "Per-user detection?", supahound: "Yes. Detectors run per actor.", them: "Not described." },
      { feature: "When does it run?", supahound: "Continuously on paid plans; posture scan daily.", them: "Before publish or on demand. Scheduled deep scans need Enterprise." },
      { feature: "Works outside Lovable?", supahound: "Yes. Any Supabase app.", them: "No. Lovable projects only." },
      { feature: "Price to scan", supahound: "Posture scan free for up to 3 projects.", them: "Free. Fixes past the free allotment use credits." },
    ],
    strengths: [
      "The quick scan runs automatically in the publish dialog: a database review of access rules, an npm dependency audit and an MCP server check.",
      "The deep scan reviews application code across seven areas, including access control, injection and leaked secrets, and checks that server code honors ownership rules.",
      "The database review flags tables without per-record access control and rules that let everyone through.",
      "Optional connectors add Wiz (SCA and SAST) and Aikido AI penetration testing.",
    ],
    gaps: [
      "The built-in scans are static analysis of code and configuration. The docs do not describe analysis of runtime logs.",
      "Scans run before publishing or on demand. Scheduled scans need an Enterprise plan.",
      "It works inside Lovable projects only, not for Supabase apps built elsewhere.",
    ],
    pricing:
      "Running either scan is free. \"Try to fix all\" uses a shared allotment of 10 free fixes that refreshes 24 hours after each use; after that, fixes use credits. Scheduled deep scans are Enterprise only, and the workspace Security center is for Business and Enterprise plans. See Lovable's pricing page for plan prices.",
    bestFor:
      "if you build in Lovable and want a free check before each publish without leaving the editor.",
    chooseSupahound:
      "if your Lovable app is live on Supabase and you want to know when a signed-in user reads other users' rows, a key leaks or a bot scrapes your tables.",
    faqs: [
      {
        q: "Should I keep using Lovable's security scan if I add Supahound?",
        a: "Yes. The quick scan catches open access rules and vulnerable npm packages before you publish. Supahound does not scan code or dependencies, so the two cover different moments.",
      },
      {
        q: "Does Lovable Security Scan watch my app after I publish?",
        a: "Its docs describe scans of code and configuration that run before publish or on demand. Scheduled deep scans need an Enterprise plan. The docs do not describe reading runtime logs.",
      },
      {
        q: "Does Supahound work with apps built outside Lovable?",
        a: "Yes. Supahound connects to any Supabase org through read-only OAuth. It does not matter which tool wrote the app.",
      },
    ],
    sources: [
      { label: "Lovable docs: Security", url: "https://docs.lovable.dev/features/security" },
      { label: "Lovable pricing", url: "https://lovable.dev/pricing" },
    ],
    checked: "2026-11-08",
  },
  {
    slug: "supaexplorer",
    name: "SupaExplorer",
    url: "https://supaexplorer.com",
    category: "One-time scanner",
    meta: {
      title: "SupaExplorer alternative for Supabase monitoring",
      description:
        "SupaExplorer finds leaked Supabase keys and tables without RLS at a point in time. Supahound reads your edge logs and flags abnormal traffic per user.",
      h1: "Supahound vs SupaExplorer: point-in-time audits vs live traffic detection",
      intro:
        "SupaExplorer is a free leaked-key URL scanner and Chrome extension, plus a low-cost platform that audits Supabase projects. Supahound reads each project's edge logs and alerts on abnormal traffic per user. SupaExplorer shows what is exposed at the moment you scan; Supahound shows who is using the exposure.",
    },
    rows: [
      { feature: "Finds leaked keys in your front end?", supahound: "No. It detects service-key misuse in traffic.", them: "Yes. The URL scanner checks pages and JS files." },
      { feature: "Checks RLS coverage?", supahound: "Yes. Free daily posture scan.", them: "Yes. Project Audit shows RLS status per table." },
      { feature: "Watches live Supabase traffic?", supahound: "Yes. Edge logs every 1–2 minutes on paid plans.", them: "No. The site does not mention logs or traffic." },
      { feature: "Per-user detection?", supahound: "Yes. Detectors run per actor.", them: "Not described." },
      { feature: "Needs a service-role key?", supahound: "No. Read-only OAuth.", them: "Not stated. The site says only \"Connect your Supabase project directly\"." },
      { feature: "Price", supahound: "Free posture scan; $29 per project per month for detection.", them: "Free tools; platform $9 per month, $90 per year or $249 lifetime." },
    ],
    strengths: [
      "The URL scanner fetches a page and its JS files to find exposed Supabase URLs, anon keys and service role keys, and shows where each one sits.",
      "Project Audit gives a table inventory with RLS status and shows which tables are publicly readable.",
      "Low price, with a lifetime option, and audit snapshots you can compare over time to catch regressions.",
      "A free RLS policy generator and a library of 25+ RLS patterns.",
    ],
    gaps: [
      "Scans and audits are point-in-time. The site does not mention reading Supabase logs or traffic.",
      "No per-user or per-actor detection is described.",
      "The site does not say how Project Audit connects to a Supabase project: OAuth, token or key.",
    ],
    pricing:
      "The free tools (URL scanner, Chrome extension, checklist and RLS policy generator) need no signup. The paid Cloud Platform is one plan with every feature: $9 per month, $90 per year or $249 lifetime; a promotion showed 25% off when we checked. Limits are 10 teams, 20 members per team, 50 domains per team and 200 reports per domain.",
    bestFor:
      "if you want a cheap, quick check for leaked keys and tables without RLS before launch.",
    chooseSupahound:
      "if you are past launch and want alerts when someone actually reads across tenants, misuses a service key or bulk-exports a table.",
    faqs: [
      {
        q: "Can SupaExplorer and Supahound run on the same project?",
        a: "Yes. Use SupaExplorer's URL scanner to find a key in your bundle before launch. Use Supahound to see whether anyone uses a leaked key against your project after launch.",
      },
      {
        q: "Does SupaExplorer need my service-role key?",
        a: "Its site says only \"Connect your Supabase project directly\" and does not name the credential. Supahound uses read-only OAuth with the analytics:read and database:read scopes and never asks for a service-role key.",
      },
      {
        q: "Is a point-in-time audit enough?",
        a: "An audit tells you which tables are open today. It cannot tell you that one signed-in user started reading every other user's rows an hour ago. That needs the logs, which is what Supahound reads.",
      },
    ],
    sources: [
      { label: "SupaExplorer home and pricing", url: "https://supaexplorer.com" },
      { label: "SupaExplorer free tools", url: "https://supaexplorer.com/tools/" },
      { label: "SupaExplorer leak scanner", url: "https://supaexplorer.com/supabase-leak-scanner" },
    ],
    checked: "2026-11-08",
  },
  {
    slug: "vibe-app-scanner",
    name: "Vibe App Scanner",
    url: "https://vibeappscanner.com",
    category: "One-time scanner",
    meta: {
      title: "Supahound vs Vibe App Scanner (VAS) for Supabase",
      description:
        "Vibe App Scanner tests your live app from outside and reviews your code. Supahound reads your Supabase edge logs and flags what each real user does.",
      h1: "Supahound vs Vibe App Scanner: outside-in tests vs inside-the-logs detection",
      intro:
        "Vibe App Scanner (VAS) is an external scanner for AI-built apps: it tests a live URL and reviews source code from GitHub. Supahound reads your Supabase edge logs and alerts on abnormal traffic per user. VAS attacks your app to find holes; Supahound watches real users to see who goes through them.",
    },
    rows: [
      { feature: "Tests the live app from outside?", supahound: "No. It reads your logs.", them: "Yes. Database, auth and APIs, including missing RLS." },
      { feature: "Reviews source code?", supahound: "No.", them: "Yes. From GitHub or a ZIP upload." },
      { feature: "Watches live Supabase traffic?", supahound: "Yes. Edge logs every 1–2 minutes on paid plans.", them: "No. It does not read Supabase logs." },
      { feature: "Per-user detection?", supahound: "Yes. Detectors run per actor.", them: "Not described." },
      { feature: "How often does it check?", supahound: "Every 1–2 minutes on paid plans.", them: "On demand; weekly monitoring on Pro." },
      { feature: "Price for one project", supahound: "$29 per month (Builder).", them: "First scan free; Go $29 per month; Pro $49 per month." },
    ],
    strengths: [
      "Tests the deployed app's database, auth and APIs from outside, including missing Supabase RLS and Firebase rules.",
      "Separate source-code review from GitHub or a ZIP upload.",
      "Pro deep scans can log in and test authenticated access.",
      "A remote MCP server lets Cursor, Claude Code or Windsurf start scans and pull reports (Pro or an eligible AppSumo plan).",
    ],
    gaps: [
      "Scans run from outside, on demand or weekly. VAS does not read Supabase logs, so it cannot see who reads data in production.",
      "No per-actor detection of cross-tenant reads, credential stuffing or scraping is described.",
      "Monitoring is weekly on Pro. Go has no automated monitoring.",
    ],
    pricing:
      "Free covers your first live-app scan, with one finding revealed. Go is $29 per month for 20 live-app scans and 10 repository scans per month, up to 3 projects, with no automated monitoring. Pro is $49 per month for 150 live-app and 50 repository scans per month, weekly extended scans, weekly monitoring with alerts, breach and email checks, and up to 10 projects. These prices are for new accounts; an AppSumo lifetime deal also exists.",
    bestFor:
      "if you build on any stack (Supabase, Firebase and others) and want an outside-in test of the live app and a code review in one cheap plan.",
    chooseSupahound:
      "if your app runs on Supabase and you need to know within minutes when a real user or a leaked key starts doing something abnormal.",
    faqs: [
      {
        q: "Does Vibe App Scanner monitor my app continuously?",
        a: "Pro includes weekly monitoring with alerts. Go has no automated monitoring. Neither plan reads Supabase logs, so VAS cannot see what real users do between scans.",
      },
      {
        q: "Can VAS find a missing RLS policy?",
        a: "Yes. It tests the deployed app's database from outside, including missing Supabase RLS. Supahound's free posture scan also reports RLS coverage, then its paid detectors watch whether anyone exploits a gap.",
      },
      {
        q: "Does Supahound work for Firebase apps?",
        a: "No. Supahound reads Supabase edge logs only. If you run Firebase, VAS covers it and Supahound does not.",
      },
    ],
    sources: [
      { label: "Vibe App Scanner home", url: "https://vibeappscanner.com" },
      { label: "Vibe App Scanner pricing", url: "https://vibeappscanner.com/pricing" },
    ],
    checked: "2026-11-08",
  },
  {
    slug: "aikido",
    name: "Aikido",
    url: "https://www.aikido.dev",
    category: "SAST/SCA and AI pentest",
    meta: {
      title: "Supahound vs Aikido Security for Supabase apps",
      description:
        "Aikido scans code and runs AI pentests that connect to Supabase. Supahound watches production Supabase logs for attacks in progress. Here is how they differ.",
      h1: "Supahound vs Aikido: AppSec suite and pentests vs live Supabase monitoring",
      intro:
        "Aikido Security is a developer AppSec suite (SCA, SAST, secrets, cloud, DAST and runtime protection) with AI pentests that connect to Supabase. Supahound watches production Supabase edge logs and flags abnormal traffic per user. Aikido tests your app at a point in time; Supahound watches it between tests.",
    },
    rows: [
      { feature: "Scans code and dependencies?", supahound: "No.", them: "Yes. SCA, SAST, AI SAST, secrets, IaC and containers." },
      { feature: "Tests Supabase by attacking it?", supahound: "No. Detection only.", them: "Yes. AI pentests test RLS, storage, Edge Functions, PostgREST, Auth and more." },
      { feature: "Watches live Supabase traffic?", supahound: "Yes. Edge logs every 1–2 minutes on paid plans.", them: "Not described. Its runtime protection uses its own in-app agent, not Supabase logs." },
      { feature: "Cross-user data leaks?", supahound: "Detects cross-tenant reads as they happen.", them: "Pentests test IDOR (cross-user data leakage)." },
      { feature: "Compliance pentest reports?", supahound: "No.", them: "Yes. Audit-grade reports for SOC 2 and ISO 27001." },
      { feature: "How it connects to Supabase", supahound: "Read-only OAuth.", them: "OAuth for pentests, with no personal access token stored." },
    ],
    strengths: [
      "A broad free tier: SCA, SAST and AI SAST, secrets detection, cloud misconfiguration, IaC, container scanning and DAST.",
      "The AI pentest connects to a Supabase organization by OAuth (no personal access token stored) and tests RLS, storage buckets, Edge Functions, PostgREST exposure, Auth, Realtime and key exposure.",
      "Pentests test IDOR (cross-user data leakage) and role-based access, with audit-grade reports for SOC 2 and ISO 27001.",
      "Available as an AI pentest connector inside Lovable.",
    ],
    gaps: [
      "Pentests test the app at a point in time, or per deploy on the quote-only continuous plan. They do not watch production Supabase logs for attacks in progress.",
      "Code scanning reads repositories, not Supabase runtime traffic.",
      "Per-project monitoring of live Supabase traffic is not described. Paid tiers are priced per team, not per Supabase project.",
    ],
    pricing:
      "The Developer tier is $0, free forever, for 2 users, 10 repos, 1 domain and 250k protected requests per month. Paid tiers (Basic, Pro and Advanced) are priced by number of users on Aikido's pricing page. A Typical Pentest is $4,000 per assessment; a Rightsized Pentest runs from $50 to $30,000+, scoped to the app; continuous testing is by quote. Aikido's pentest terms say \"No High or Critical Finding = Don't Pay\".",
    bestFor:
      "if you need code scanning, compliance-grade pentest reports and a broad AppSec platform more than live Supabase traffic monitoring.",
    chooseSupahound:
      "if you want to know, within minutes, when a real user reads across tenants or a service key is misused in production, at a per-project price.",
    faqs: [
      {
        q: "Aikido's pentest already tests IDOR. Why would I add Supahound?",
        a: "A pentest proves whether a cross-user leak is possible when it runs. Supahound tells you when a real user actually reads other users' rows in production.",
      },
      {
        q: "Does Aikido read Supabase logs?",
        a: "No. Aikido's runtime protection counts protected requests through its own in-app agent; it does not read Supabase edge logs. Aikido connects to Supabase for pentests.",
      },
      {
        q: "Can Supahound produce a SOC 2 pentest report?",
        a: "No. Supahound does not produce compliance pentest reports. If an auditor or a customer asks for one, Aikido or a pentest vendor fits that need.",
      },
    ],
    sources: [
      { label: "Aikido pricing", url: "https://www.aikido.dev/pricing" },
      { label: "Aikido help: integrate your Supabase projects", url: "https://help.aikido.dev/pentests/integrate-your-supabase-projects.md" },
      { label: "Lovable docs: Security (Aikido connector)", url: "https://docs.lovable.dev/features/security" },
    ],
    checked: "2026-11-08",
  },
  {
    slug: "snyk",
    name: "Snyk",
    url: "https://snyk.io",
    category: "SAST/SCA",
    meta: {
      title: "Supahound vs Snyk: code scanning vs Supabase traffic",
      description:
        "Snyk scans code, dependencies, containers and IaC before deploy. Supahound watches Supabase traffic after deploy. Use both if you ship on Supabase.",
      h1: "Supahound vs Snyk: before-deploy scanning vs after-deploy detection",
      intro:
        "Snyk is a developer security platform that scans code, open-source dependencies, containers and IaC for vulnerabilities. Supahound reads Supabase edge logs and flags abnormal traffic per user. Snyk catches bugs before deploy; Supahound catches abuse after deploy. They complement each other.",
    },
    rows: [
      { feature: "Scans code and dependencies?", supahound: "No.", them: "Yes. SCA, SAST, IaC and containers." },
      { feature: "Watches live Supabase traffic?", supahound: "Yes. Edge logs every 1–2 minutes on paid plans.", them: "No. It does not read Supabase runtime logs." },
      { feature: "Supabase-specific checks?", supahound: "Yes. RLS coverage, Security Advisor findings, exposed tables.", them: "None appear on the plans page." },
      { feature: "Detects credential stuffing or scraping?", supahound: "Yes, per actor.", them: "No." },
      { feature: "Where it fits", supahound: "Production, after deploy.", them: "IDE, CI and pull requests, before deploy." },
      { feature: "Free plan", supahound: "Posture scan for up to 3 projects.", them: "5 projects, 100 Snyk Code tests per month." },
    ],
    strengths: [
      "Mature SCA, SAST, IaC and container scanning on the free plan.",
      "Fits the developer workflow (IDE, CI and pull requests) to catch issues before deploy.",
      "The Enterprise rate card adds secrets, API and web testing.",
    ],
    gaps: [
      "Scans code, dependencies and infrastructure files. It does not read Supabase runtime logs.",
      "No Supabase-specific checks, such as RLS coverage or Security Advisor findings, appear on the plans page.",
      "It cannot detect live abuse such as credential stuffing, scraping or one user reading another user's rows.",
    ],
    pricing:
      "Free is $0 per month for 5 projects and 100 Snyk Code tests per month; the FAQ lists 200 Open Source, 100 Code, 300 IaC and 100 Container tests. Team starts at $25 per month for 100 projects, 1,000 Snyk Code tests per month and Jira integration. Enterprise is through sales, with prepaid credits at 1 credit = $1.",
    bestFor:
      "if you want to catch vulnerable dependencies and insecure code before deploy, on any stack. Keep it when you add Supahound.",
    chooseSupahound:
      "as well, if your app runs on Supabase: Snyk cannot see a bad RLS policy being used in production, and Supahound can.",
    faqs: [
      {
        q: "Is Supahound a Snyk replacement?",
        a: "No. Supahound does not scan code or dependencies. Snyk does not read Supabase logs. Run Snyk in CI and Supahound against production.",
      },
      {
        q: "Will Snyk find a missing RLS policy?",
        a: "Snyk's plans page lists no Supabase-specific checks such as RLS coverage. Supahound's free daily posture scan reports RLS coverage, Security Advisor findings and newly exposed tables.",
      },
      {
        q: "Which one catches a scraper?",
        a: "Supahound. Scraping happens at runtime, in traffic Snyk never sees. Supahound's per-actor detectors flag bulk export from your Supabase edge logs.",
      },
    ],
    sources: [{ label: "Snyk plans and pricing", url: "https://snyk.io/plans/" }],
    checked: "2026-11-08",
  },
  {
    slug: "arcjet",
    name: "Arcjet",
    url: "https://arcjet.com",
    category: "In-app WAF and bot protection SDK",
    meta: {
      title: "Supahound vs Arcjet for Supabase apps",
      description:
        "Arcjet blocks bots and abuse inside your own route handlers. Supahound reads Supabase edge logs, so it sees PostgREST calls that skip your server.",
      h1: "Supahound vs Arcjet: blocking in your routes vs detecting in Supabase logs",
      intro:
        "Arcjet is a security SDK you call in your route handlers for bot detection, rate limiting, WAF rules and signup protection. Supahound reads Supabase edge logs and alerts on abnormal traffic per user. Arcjet blocks requests that pass through your server; Supahound sees the requests that go straight to Supabase.",
    },
    rows: [
      { feature: "Blocks attacks?", supahound: "No. Detection and alerts only.", them: "Yes. Inline, before the handler runs." },
      { feature: "Sees direct Supabase API calls?", supahound: "Yes. It reads Supabase edge logs.", them: "No. Only requests through your routes that call protect()." },
      { feature: "Detects cross-tenant reads?", supahound: "Yes, per actor.", them: "No. It does not read Supabase logs." },
      { feature: "Supabase posture checks?", supahound: "Yes. Free daily scan.", them: "No." },
      { feature: "Code changes needed?", supahound: "No. Connect with OAuth.", them: "Yes. Call the SDK in each route you protect." },
      { feature: "Entry price", supahound: "Free posture scan; $29 per project per month for detection.", them: "Free plan: 10,000 requests per month after a 15-day trial. Individual: $25 per month plus usage." },
    ],
    strengths: [
      "Blocks bots, rate-limits and applies Shield WAF inline, before the handler runs, with signup protection and email validation.",
      "SDKs for Next.js, Node.js, Express, Hono, Bun, Deno, SvelteKit, Remix, Astro, FastAPI, Flask and more.",
      "Also guards AI agents: prompt injection, PII detection and tool-call guards.",
    ],
    gaps: [
      "It sees only requests that pass through your own route handlers where you call protect(). The site does not mention Supabase.",
      "It does not read Supabase logs, so it cannot attribute PostgREST reads to users or detect cross-tenant reads.",
      "No Supabase posture checks, such as RLS coverage or Security Advisor findings.",
    ],
    pricing:
      "Individual is $25 per month (1 member, 1 hour of log retention). Startup is $299 per month (2 members, 24 hours of retention). Enterprise is custom. Usage costs $5 per 1M web requests and $50 per 1M agent requests. After the 15-day trial, the free plan allows 10,000 requests per month with a hard stop.",
    bestFor:
      "if your traffic goes through your own server routes and you want to block bots and abuse inline, not just get alerts.",
    chooseSupahound:
      "if your front end calls Supabase directly with the anon key, so those reads never touch a route where Arcjet runs.",
    faqs: [
      {
        q: "Can I use Arcjet and Supahound together?",
        a: "Yes. Arcjet blocks abuse on the routes you control. Supahound watches the PostgREST, Auth and Storage calls that go straight to Supabase, where Arcjet is not in the path.",
      },
      {
        q: "Why can't Arcjet see a cross-tenant read?",
        a: "A Supabase client in the browser sends PostgREST requests to your project's API URL, not to your server. Arcjet runs only where you call protect(), so those reads never reach it.",
      },
      {
        q: "Does Supahound block anything?",
        a: "No. Supahound detects and alerts, with a plain-English summary and a paste-ready SQL fix. If you need inline blocking on your own routes, Arcjet does that.",
      },
    ],
    sources: [
      { label: "Arcjet home", url: "https://arcjet.com" },
      { label: "Arcjet pricing", url: "https://arcjet.com/pricing" },
    ],
    checked: "2026-11-08",
  },
  {
    slug: "sentry",
    name: "Sentry",
    url: "https://sentry.io",
    category: "Error tracking and APM",
    meta: {
      title: "Supahound vs Sentry for Supabase security",
      description:
        "Sentry tracks errors and performance, with a Supabase client integration. Supahound reads Supabase edge logs and detects abuse per user, even direct API calls.",
      h1: "Supahound vs Sentry: error tracking vs security detection for Supabase",
      intro:
        "Sentry is error tracking and performance monitoring, with a Supabase client integration that records query and auth spans. Supahound reads Supabase edge logs and flags abnormal traffic per user. Sentry tells you what broke in your own code; Supahound tells you who is abusing your Supabase project.",
    },
    rows: [
      { feature: "Built for", supahound: "Security detection.", them: "Errors and performance." },
      { feature: "Sees direct API calls with your anon key?", supahound: "Yes. It reads Supabase edge logs.", them: "Not through the SDK integration, which records your own client's calls." },
      { feature: "Reads Supabase edge logs?", supahound: "Yes, through read-only OAuth.", them: "Only through a log drain, which needs Supabase Pro, Team or Enterprise." },
      { feature: "Security detectors included?", supahound: "Yes. Cross-tenant reads, key misuse, stuffing, scraping, tampering.", them: "Not mentioned on the Supabase integration page. You write your own alert rules." },
      { feature: "Per-user detection?", supahound: "Yes. Detectors run per actor.", them: "Not described." },
      { feature: "Entry price", supahound: "Free posture scan; $29 per project per month for detection.", them: "Developer free; Team $29 per month (monthly)." },
    ],
    strengths: [
      "The Supabase integration captures spans for auth operations (signInWithPassword, signUp, signOut and admin calls) and for database operations.",
      "Query dashboards and detailed error context for failed Supabase operations.",
      "Supabase can drain logs to Sentry's Logging product on Supabase Pro, Team or Enterprise.",
    ],
    gaps: [
      "Built for errors and performance. The Supabase integration page does not mention security events or threat detection.",
      "The integration records calls made by your own client code. Direct API calls by an attacker who uses your anon key do not pass through it.",
      "Getting Supabase edge logs into Sentry needs a log drain, which needs a Supabase Pro, Team or Enterprise plan. You then write your own alert rules.",
    ],
    pricing:
      "Developer is free (5k errors, 5M spans, 50 replays, 5GB of logs). Team is $29 per month billed monthly or $26 billed annually. Business is $89 per month billed monthly or $80 billed annually. Enterprise is custom. Extra logs cost $0.50 per GB.",
    bestFor:
      "if you need error tracking and performance monitoring first. It complements security monitoring; it does not replace it.",
    chooseSupahound:
      "if you want security detectors you do not write yourself, some of which alert from day one, and that see attackers who never load your front end.",
    faqs: [
      {
        q: "Can Sentry's Supabase integration detect an attacker?",
        a: "The integration records spans from your own client code. An attacker who copies your anon key and calls the Supabase API directly never runs that code, so Sentry does not see the requests.",
      },
      {
        q: "Could I build Supahound's detectors in Sentry with a log drain?",
        a: "You could drain Supabase logs to Sentry on a Pro, Team or Enterprise plan and write your own alert rules. Supahound ships per-actor detectors, groups findings into incidents and writes a summary and a SQL fix for each incident.",
      },
      {
        q: "Should I keep Sentry if I add Supahound?",
        a: "Yes. Supahound does not track errors or performance. Sentry answers \"what broke\"; Supahound answers \"who is abusing my data\".",
      },
    ],
    sources: [
      { label: "Sentry pricing", url: "https://sentry.io/pricing/" },
      { label: "Sentry docs: Supabase integration", url: "https://docs.sentry.io/platforms/javascript/configuration/integrations/supabase/" },
      { label: "Supabase docs: log drains", url: "https://supabase.com/docs/guides/telemetry/log-drains" },
    ],
    checked: "2026-11-08",
  },
  {
    slug: "datadog",
    name: "Datadog",
    url: "https://www.datadoghq.com",
    category: "SIEM and APM",
    meta: {
      title: "Supahound vs Datadog Cloud SIEM for Supabase",
      description:
        "Datadog Cloud SIEM runs 800+ detection rules on logs you ship to it. Supahound ships Supabase-specific per-user detectors and needs no service-role key.",
      h1: "Supahound vs Datadog: a general SIEM vs detectors built for Supabase",
      intro:
        "Datadog is an observability platform; this page compares its Cloud SIEM and App and API Protection products. Supahound reads Supabase edge logs and flags abnormal traffic per user. Datadog gives a security team a general detection engine across many systems; Supahound gives a Supabase team detectors that already know Supabase.",
    },
    rows: [
      { feature: "Supabase-specific detectors?", supahound: "Yes. Cross-tenant reads, service-key misuse and more.", them: "Not described. You build those rules yourself." },
      { feature: "How it gets Supabase data", supahound: "Read-only OAuth; reads edge logs.", them: "Metrics integration, plus a log drain for edge logs (Supabase Pro, Team or Enterprise)." },
      { feature: "Needs a service-role key?", supahound: "No.", them: "The metrics integration uses the service_role JWT. The log-drain route does not." },
      { feature: "Detection rules", supahound: "Per-actor Supabase detectors.", them: "800+ out-of-the-box rules and threat intelligence." },
      { feature: "History", supahound: "30-day incident history.", them: "12 months of analysis and retention." },
      { feature: "Pricing model", supahound: "Per project per month.", them: "Per GB analyzed and per event indexed." },
    ],
    strengths: [
      "A real-time detection engine with 800+ out-of-the-box detection rules and threat intelligence.",
      "Bits Security Analyst investigates alerts, and you get 12 months of searchable security data.",
      "The Supabase integration collects Postgres, PgBouncer, Supavisor, PostgREST and runtime metrics.",
      "Supabase log drains can send logs to Datadog.",
    ],
    gaps: [
      "The Supabase integration collects metrics only and includes no events. Edge logs need a Supabase log drain, which needs a Pro, Team or Enterprise plan.",
      "The integration's metrics endpoint uses the service_role JWT as its password.",
      "No Supabase-specific detection for cross-tenant reads or service-role key misuse is described. You build those rules yourself.",
      "Usage-based pricing per GB and per event is designed for larger teams.",
    ],
    pricing:
      "Cloud SIEM starts at $5 per GB analyzed per month billed annually, or $7.50 on demand, with 12 months of analysis and retention. Log Management costs $0.10 per GB ingested, and standard indexing costs $1.70 per million events (annual) or $2.55 (on demand). See Datadog's pricing page for the App and API Protection price.",
    bestFor:
      "if you already run Datadog and have a security team to write and tune detection rules across many systems.",
    chooseSupahound:
      "if you want Supabase detectors that work without writing rules, without a service-role key and without per-GB billing.",
    faqs: [
      {
        q: "Does Datadog's Supabase integration need my service-role key?",
        a: "Yes, for metrics: its metrics endpoint uses the service_role JWT as its password. The log-drain route does not. Supahound never asks for a service-role key; it uses read-only OAuth.",
      },
      {
        q: "Does Datadog detect cross-tenant reads on Supabase out of the box?",
        a: "Datadog's docs do not describe a Supabase-specific rule for it. Its SIEM ships 800+ general rules, and you would write a cross-tenant rule yourself on drained edge logs.",
      },
      {
        q: "We already pay for Datadog. Is Supahound still worth it?",
        a: "If your security team has time to build and tune Supabase rules in Datadog, you may not need it. If not, Supahound adds per-actor Supabase detectors for a fixed price per project.",
      },
    ],
    sources: [
      { label: "Datadog pricing", url: "https://www.datadoghq.com/pricing/" },
      { label: "Datadog pricing: Cloud SIEM", url: "https://www.datadoghq.com/pricing/?product=cloud-siem#products" },
      { label: "Datadog price list", url: "https://www.datadoghq.com/pricing/list/" },
      { label: "Datadog docs: Supabase integration", url: "https://docs.datadoghq.com/integrations/supabase/" },
      { label: "Supabase docs: log drains", url: "https://supabase.com/docs/guides/telemetry/log-drains" },
    ],
    checked: "2026-11-08",
  },
  {
    slug: "cloudflare-waf",
    name: "Cloudflare WAF",
    url: "https://www.cloudflare.com/application-services/products/waf/",
    category: "WAF",
    meta: {
      title: "Supahound vs Cloudflare WAF for Supabase apps",
      description:
        "Cloudflare WAF blocks attacks at the edge for traffic in your zone. Supahound reads Supabase logs and flags per-user abuse that a WAF cannot attribute.",
      h1: "Supahound vs Cloudflare WAF: blocking at the edge vs detecting per user",
      intro:
        "Cloudflare WAF and Bot Management form an edge firewall and bot filter for traffic proxied through your Cloudflare zone. Supahound reads Supabase edge logs and flags abnormal traffic per user. Cloudflare blocks known-bad requests before they arrive; Supahound spots a signed-in user doing something wrong with valid requests. Use both.",
    },
    rows: [
      { feature: "Blocks attacks?", supahound: "No. Detection and alerts only.", them: "Yes. At the edge, before traffic reaches the app." },
      { feature: "Sees Supabase API calls?", supahound: "Yes. It reads Supabase edge logs.", them: "Only if you route the Supabase API URL through your zone." },
      { feature: "Knows which user owns which rows?", supahound: "Yes. It flags cross-tenant reads.", them: "No." },
      { feature: "Bot protection", supahound: "Detects scraping and credential stuffing per actor.", them: "Bot mitigation on every plan." },
      { feature: "Supabase posture checks?", supahound: "Yes. Free daily scan.", them: "No." },
      { feature: "Entry price", supahound: "Free posture scan; $29 per project per month for detection.", them: "Free; Pro from $20 per month billed annually." },
    ],
    strengths: [
      "Blocks attacks at the edge before they reach the app, with a free managed ruleset.",
      "Bot mitigation on every plan, with anomaly detection and advanced bot analytics on contract plans.",
      "Low entry price and no code changes for traffic already on Cloudflare.",
    ],
    gaps: [
      "It protects only traffic proxied through your Cloudflare zone. Supabase client calls go to the project's API URL, which is not in your zone unless you route it there.",
      "It does not read Supabase logs or know which Supabase user owns which rows, so it cannot flag cross-tenant reads.",
      "No Supabase posture checks, such as RLS coverage or Security Advisor findings.",
    ],
    pricing:
      "Free is $0. Pro is $20 per month billed annually or $25 monthly. Business is $200 per month billed annually or $250 monthly. Contract plans are custom and billed annually. WAF and the Free Managed Ruleset come with every plan. Bot mitigation grows by plan: simple bots on Free, easy-to-detect bots on Pro, sophisticated bots with basic analytics on Business, and all bots with anomaly detection, custom CAPTCHAs and advanced analytics on Contract.",
    bestFor:
      "if your site already proxies traffic through Cloudflare and you want to block bots and common attacks at the edge.",
    chooseSupahound:
      "alongside it, if your app calls Supabase directly: a WAF cannot tell that a valid, signed-in request is reading another tenant's rows.",
    faqs: [
      {
        q: "Does Cloudflare WAF protect my Supabase API?",
        a: "Only if the traffic passes through your Cloudflare zone. By default, Supabase client calls go to your project's API URL, which sits outside your zone.",
      },
      {
        q: "If Cloudflare blocks bots, why do I need Supahound?",
        a: "A signed-in user reading other users' rows, or a caller with a leaked service key, sends valid requests. A firewall that does not know which user owns which rows cannot flag them. Supahound reads the logs per actor.",
      },
      {
        q: "Can Supahound block an attacker for me?",
        a: "No. Supahound is detection only. It sends an email or a signed webhook with a summary and a SQL fix; Cloudflare or your own code does the blocking.",
      },
    ],
    sources: [
      { label: "Cloudflare WAF product page", url: "https://www.cloudflare.com/application-services/products/waf/" },
      { label: "Cloudflare plans", url: "https://www.cloudflare.com/plans/" },
      { label: "Cloudflare plan comparison (network and CDN)", url: "https://www.cloudflare.com/plans/network-cdn.md" },
      { label: "Cloudflare docs: bot plans", url: "https://developers.cloudflare.com/bots/plans/" },
    ],
    checked: "2026-11-09",
  },
  {
    slug: "modernpentest",
    name: "ModernPentest",
    url: "https://modernpentest.com",
    category: "AI pentest",
    meta: {
      title: "Supahound vs ModernPentest for Supabase apps",
      description:
        "ModernPentest runs AI pentests with Supabase checks and SOC 2-ready reports. Supahound watches production Supabase logs for abuse between tests.",
      h1: "Supahound vs ModernPentest: scheduled pentests vs continuous detection",
      intro:
        "ModernPentest is AI-driven web and API pentesting with specialized Supabase, Firebase, Vercel and Convex checks. Supahound reads Supabase edge logs and flags abnormal traffic per user. ModernPentest attacks your app on a schedule to find holes; Supahound watches real users between those runs.",
    },
    rows: [
      { feature: "Tests your app by attacking it?", supahound: "No. Detection only.", them: "Yes. OWASP Top 10, OWASP API Top 10, BOLA, RLS and more." },
      { feature: "Watches live Supabase traffic?", supahound: "Yes. Edge logs every 1–2 minutes on paid plans.", them: "No. It does not read Supabase logs." },
      { feature: "Sees real users between runs?", supahound: "Yes. Detectors run per actor.", them: "No." },
      { feature: "Compliance reports?", supahound: "No.", them: "Yes. SOC 2-ready reports." },
      { feature: "Needs a service-role key?", supahound: "No. Read-only OAuth.", them: "Not published." },
      { feature: "Price", supahound: "$29 per project per month (Builder).", them: "$1,500 per scan on credits; about $333 per pentest on Starter." },
    ],
    strengths: [
      "Specialized Supabase testing, including RLS policies, plus OWASP Top 10, OWASP API Top 10, BOLA, injection and rate-limiting checks.",
      "Each finding includes the captured request and response, and fixes are verified before findings are marked fixed.",
      "Scheduled recurring tests and SOC 2-ready reports.",
    ],
    gaps: [
      "It tests the app by attacking it on a schedule. It does not read Supabase logs or watch production traffic.",
      "It is priced for teams that need audit reports: credits cost $1,500 per scan, and Starter costs $3,995 every 6 months.",
      "It cannot see attacks by real users between test runs.",
    ],
    pricing:
      "Pentest credits are sold as a 3-pack at $1,500 per scan, valid for 12 months. Starter is $3,995 prepaid every 6 months for 12 pentests on 1 application, about $333 per pentest. Professional is $2,499 per month for up to 5 applications and up to 25 pentests per month. Enterprise starts at $9,999 per month. The homepage offers a free first pentest.",
    bestFor:
      "if you need dated pentest attestations for SOC 2 or customer security reviews.",
    chooseSupahound:
      "if you need to know what real users and leaked keys do in production every day, not only on the days a pentest runs.",
    faqs: [
      {
        q: "Does a ModernPentest report replace runtime monitoring?",
        a: "No. A pentest shows which holes existed on the test date. It cannot see a real user exploiting a hole that a later deploy opened. Supahound reads your logs between tests.",
      },
      {
        q: "Does Supahound test my RLS policies the way a pentest does?",
        a: "No. Supahound does not send attack traffic. Its free posture scan reports RLS coverage, and its paid detectors flag real cross-tenant reads in your logs.",
      },
      {
        q: "Which one do I need for a SOC 2 audit?",
        a: "If the auditor asks for a pentest report, ModernPentest provides SOC 2-ready reports. Supahound does not produce compliance pentest reports.",
      },
    ],
    sources: [
      { label: "ModernPentest home", url: "https://modernpentest.com" },
      { label: "ModernPentest pricing", url: "https://modernpentest.com/pricing" },
    ],
    checked: "2026-11-08",
  },
];

export const competitor = (slug: string) => competitors.find((c) => c.slug === slug);
