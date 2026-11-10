// Written from the platform research. See content/platforms.ts.
import type { Platform, Source } from "../types";

const CHECKED = "2026-11-09";

// Supabase documentation that several entries rely on.
const SB = {
  mcp: { label: "Supabase: Model Context Protocol (MCP) guide", url: "https://supabase.com/docs/guides/getting-started/mcp" },
  tables: { label: "Supabase: Tables and RLS defaults", url: "https://supabase.com/docs/guides/database/tables" },
  rls: { label: "Supabase: Row Level Security", url: "https://supabase.com/docs/guides/database/postgres/row-level-security" },
  keys: { label: "Supabase: API keys", url: "https://supabase.com/docs/guides/api/api-keys" },
  securing: { label: "Supabase: Securing your API", url: "https://supabase.com/docs/guides/api/securing-your-api" },
  advisors: {
    label: "Supabase: Database Advisors (lint 0013 and related lints)",
    url: "https://supabase.com/docs/guides/database/database-advisors?queryGroups=lint&lint=0013_rls_disabled_in_public",
  },
  functions: { label: "Supabase: Edge Function configuration", url: "https://supabase.com/docs/guides/functions/function-configuration" },
} satisfies Record<string, Source>;

const GENERAL_ANALYSIS: Source = {
  label: "General Analysis: Supabase MCP prompt-injection demonstration (July 2025)",
  url: "https://generalanalysis.com/blog/supabase-mcp-blog",
};

const ESCAPE: Source = {
  label: "Escape.tech: How we found vulnerabilities in 5,600+ vibe-coded apps (October 2025)",
  url: "https://escape.tech/blog/methodology-how-we-discovered-vulnerabilities-apps-built-with-vibe-coding/",
};

const RLS_OFF_QUERY =
  "-- Every table in public without RLS. Expect zero rows.\nselect c.relname\nfrom pg_class c\njoin pg_namespace n on n.oid = c.relnamespace\nwhere n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;";

export const groupB: Platform[] = [
  // ---------------------------------------------------------------- Cursor
  {
    slug: "cursor",
    name: "Cursor",
    url: "https://cursor.com",
    kind: "ai-editor",
    integration: "supported",
    oneLine: "AI code editor, a VS Code fork, whose agents edit code and call MCP tools such as Supabase's.",
    checked: CHECKED,
    landing: {
      title: "Supabase monitoring for apps you build in Cursor",
      description:
        "Cursor's agent writes your Supabase migrations and can query your project over MCP. Supahound watches what reaches the database after you ship.",
      h1: "Monitor the Supabase backend of an app you build in Cursor",
      intro:
        "Cursor has no database of its own. Supabase arrives through a Marketplace plugin, made by Supabase, that gives Cursor's agent the MCP server and Supabase's skills. That agent can write and run SQL, so a table can ship without RLS, and a General Analysis demo showed what a service_role connection can leak. Supahound checks every table's RLS daily and alerts when your secret key turns up somewhere new.",
      risks: [
        {
          title: "An MCP connection with more access than the task needs",
          detail:
            "The Supabase plugin in the Cursor Marketplace bundles the Supabase MCP server, and you can also add the server to .cursor/mcp.json. Supabase names prompt injection as the main LLM-specific attack on MCP. It advises scoping the server to one project, using read-only mode, and connecting to production only when a task needs it.",
        },
        {
          title: "Service-role access while the agent reads user content",
          detail:
            "In a July 2025 research demonstration by General Analysis, Cursor's agent used the Supabase MCP server as service_role, read a support ticket with hidden instructions, and copied a private integration_tokens table into the ticket thread. No customer breach was reported. The lesson is about the connection, not the editor: an agent that bypasses RLS should not read text an attacker can write.",
        },
        {
          title: "Tables from Cursor-written SQL start with RLS off",
          detail:
            "When Cursor's agent writes a create table migration, Supabase does not turn RLS on for that table. Only tables made in the Dashboard Table Editor get RLS automatically. Security Advisor rates a public table without RLS as ERROR (lint 0013), because anyone with the project URL can create, read, update and delete its rows.",
        },
        {
          title: "A secret key in a NEXT_PUBLIC_ or VITE_ variable",
          detail:
            "If a Cursor edit puts a sb_secret_ or service_role key in a client-exposed variable, the key ships in your bundle. It maps to service_role, which has BYPASSRLS. Supabase rejects a secret key sent from a browser with HTTP 401, but that check reads the User-Agent, so a copied key still works from a script.",
        },
        {
          title: "Views that return every row",
          detail:
            "Postgres creates views as security definer, usually owned by postgres. A view Cursor adds over an RLS table can therefore return rows the caller could never read from the table itself. Security Advisor flags this as lint 0010. The fix is security_invoker = on.",
        },
      ],
      howSupahoundHelps: [
        "The free daily posture scan lists every table without RLS, so a table from a Cursor migration shows up in the next scan.",
        "The same scan lists views without security_invoker and includes your Security Advisor findings.",
        "The service-key detector alerts from day one when a secret key is used from a browser or from a network the project has not seen, which is how a leaked NEXT_PUBLIC_ key shows up in traffic.",
        "The scraping and bulk-export detector learns each actor's normal volume for 7 days, then flags one actor reading far more rows than usual.",
        "Each incident comes with a plain-English summary and a paste-ready SQL fix you can review in Cursor before you apply it.",
      ],
      faqs: [
        {
          q: "Does Cursor check my Supabase RLS policies?",
          a: "No. Cursor has no built-in RLS generation or Supabase security scan. The Supabase plugin adds Supabase's skills, including Postgres best practices, and its MCP server can surface Supabase advisors when you ask. Supahound runs its posture scan every day without a prompt.",
        },
        {
          q: "Should I connect the Supabase MCP server in Cursor to production?",
          a: "Only when a task needs it. That is Supabase's own advice. For daily work, scope the server to a development project and turn on read-only mode, and never give the agent a service_role connection while it reads data your users wrote.",
        },
        {
          q: "Can Supahound stop Cursor's agent from changing my database?",
          a: "No. Supahound detects; it does not block. It watches your project's traffic and alerts on database tampering from day one, with a summary and a SQL fix. You decide what to roll back.",
        },
        {
          q: "Does Supahound connect through the Supabase MCP server too?",
          a: "No. Supahound uses read-only Supabase OAuth with the read-only analytics:read, database:read and projects:read scopes and never asks for a service-role key. It reads edge logs and the schema, not your Cursor workspace.",
        },
      ],
    },
    guide: {
      title: "How to secure Supabase in Cursor: MCP, keys and RLS",
      description:
        "Connect the Supabase MCP server to Cursor with one project and read-only mode, keep secret keys out of client variables, and review RLS before you apply it.",
      h1: "How to use Cursor with Supabase without leaking data",
      intro:
        "In Cursor, install Supabase's own plugin or add its server to .cursor/mcp.json, then limit it to one development project in read-only mode. The plugin's skills help, but they do not review your SQL. Keep service_role out of the connection, ask for RLS in the same migration as each table, read every policy before it runs, and grep the build for secret keys.",
      sections: [
        {
          heading: "How do I connect Supabase to Cursor safely?",
          steps: [
            "Install the Supabase plugin from the Cursor Marketplace with Add to Cursor, then sign in with OAuth. Supabase created the plugin and Cursor verified it. It bundles the MCP server and Supabase's skills.",
            "Or add Supabase's hosted server, https://mcp.supabase.com/mcp, to .cursor/mcp.json as Supabase's MCP guide shows.",
            "Scope the server to one project, ideally a development project.",
            "Turn on read-only mode for routine work. Connect to production only when a task needs it.",
          ],
          paragraphs: [
            "Supabase's MCP guide names prompt injection as the main LLM-specific attack: text in your data that the agent treats as an instruction. Project scoping and read-only mode limit what an injected instruction can reach.",
          ],
        },
        {
          heading: "Why should Cursor's agent never connect as service_role?",
          paragraphs: [
            "service_role has BYPASSRLS. An agent connected that way can read every table, and so can any instruction hidden in the rows it reads. The General Analysis demonstration showed exactly this: a support ticket told Cursor's agent to copy a private token table into the ticket thread, and it did.",
          ],
          bullets: [
            "Keep sb_secret_ and legacy service_role keys out of .cursor/mcp.json and out of every prompt.",
            "Do not let an agent with write access read support tickets, comments or other text your users submit.",
            "Use the MCP server's OAuth sign-in instead of pasting keys.",
          ],
        },
        {
          heading: "How do I keep secret keys out of a Cursor project's client code?",
          paragraphs: [
            "Only publishable keys (sb_publishable_) belong in the browser. Anything in a NEXT_PUBLIC_, VITE_ or EXPO_PUBLIC_ variable is exposed to the client. Run these two checks after every agent session that touched config.",
          ],
          code: [
            {
              lang: "bash",
              code: "# List files that put a secret-looking name behind a client prefix.\ngrep -rlE \"(NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_)[A-Z0-9_]*(SECRET|SERVICE_ROLE)\" . --exclude-dir=node_modules 2>/dev/null\n\n# Search the build output for a secret key before you deploy.\ngrep -rlE \"sb_secret_|service_role\" .next/static/ dist/ build/ 2>/dev/null",
              caption: "Both commands should print nothing.",
            },
          ],
        },
        {
          heading: "What should I ask Cursor for when it writes a migration?",
          paragraphs: [
            "Tables created with SQL do not get RLS automatically, so say so in the prompt. Ask for RLS in the same migration as the table, one policy per command, and a with check on writes.",
          ],
          code: [
            {
              lang: "text",
              code: "Write a migration for a documents table owned by a user.\nEnable row level security in the same migration.\nAdd one policy per command for the authenticated role,\nusing (select auth.uid()) = owner_id, with a with check on insert and update.\nDo not use the service_role key and do not create views.",
              caption: "A prompt you can paste into Cursor's agent.",
            },
            {
              lang: "sql",
              code: "create table public.documents (\n  id uuid primary key default gen_random_uuid(),\n  owner_id uuid not null references auth.users (id) on delete cascade,\n  body text not null\n);\nalter table public.documents enable row level security;\n\ncreate policy \"documents: owner reads\" on public.documents\n  for select to authenticated\n  using ((select auth.uid()) = owner_id);\n\ncreate policy \"documents: owner writes\" on public.documents\n  for insert to authenticated\n  with check ((select auth.uid()) = owner_id);\n\ncreate policy \"documents: owner updates\" on public.documents\n  for update to authenticated\n  using ((select auth.uid()) = owner_id)\n  with check ((select auth.uid()) = owner_id);",
              caption: "What a correct result looks like.",
            },
          ],
        },
        {
          heading: "How do I review the policies Cursor writes before I apply them?",
          steps: [
            "Read every create policy statement. Each one should name a role with to authenticated or to anon, never leave it open.",
            "Check that every update policy has both using and with check.",
            "Check that every new view is created with security_invoker = true.",
            "Apply the migration to a development project and run the query below. It must return zero rows.",
            "Ask the agent to fetch Supabase's advisors over MCP, or open Security Advisor in the dashboard, and fix every ERROR.",
          ],
          code: [{ lang: "sql", code: RLS_OFF_QUERY }],
        },
      ],
      faqs: [
        {
          q: "Does the Supabase plugin for Cursor make my database safe?",
          a: "It gives Cursor's agent Supabase's skills, including Postgres best practices, and access to advisors through MCP. It does not approve your policies or stop a bad migration. You still read each policy before it runs.",
        },
        {
          q: "Was the General Analysis demo a breach of Cursor users?",
          a: "No. It was a research demonstration with no reported customer breach. It showed what happens when an agent with service_role access reads text an attacker controls. Read-only mode, project scoping and a connection without service_role all shrink that risk.",
        },
        {
          q: "What should I check before I deploy a Cursor-built app?",
          a: "Run the RLS-off query and expect zero rows, grep the build for sb_secret_ and service_role, and confirm every view uses security_invoker. Supahound's free posture scan repeats the RLS and view checks daily after launch.",
        },
      ],
    },
    sources: [
      { label: "Cursor: Model Context Protocol (MCP)", url: "https://cursor.com/docs/context/mcp" },
      { label: "Cursor Marketplace: Supabase plugin", url: "https://cursor.com/marketplace/mcp/supabase" },
      SB.mcp,
      GENERAL_ANALYSIS,
      SB.tables,
      SB.keys,
      SB.advisors,
    ],
  },

  // ---------------------------------------------------------------- Windsurf
  {
    slug: "windsurf",
    name: "Windsurf",
    url: "https://windsurf.com",
    kind: "ai-editor",
    integration: "supported",
    oneLine: "Cognition's agentic code editor, which can call MCP servers such as Supabase's hosted server.",
    checked: CHECKED,
    landing: {
      title: "Supabase monitoring for Windsurf projects",
      description:
        "Windsurf's agent can write your Supabase SQL and query your project over MCP. Supahound scans RLS daily and watches live traffic, read-only.",
      h1: "Monitor the Supabase backend behind your Windsurf project",
      intro:
        "Windsurf (now documented as Devin Desktop) has no Supabase flow of its own. You add Supabase's MCP server on the Customize > MCPs page or in .devin/mcp_config.json, and that one entry decides how much of your project the agent can touch. Keep it to one project and read-only. Supahound reads the same project from the other side: a free daily RLS scan, plus live detectors on its traffic.",
      risks: [
        {
          title: "An unscoped Supabase entry in Windsurf's MCP config",
          detail:
            "Windsurf adds MCP servers from its Customize > MCPs page or from .devin/mcp_config.json, and Supabase's MCP guide lists it as a client with OAuth. An entry without project scoping or read-only mode gives a prompt-injected instruction more reach than the task needs. Supabase advises one project, read-only mode, and production only when required.",
        },
        {
          title: "New public tables that anyone can query",
          detail:
            "Windsurf documents no built-in RLS generation or Supabase scan. Tables its agent creates with SQL start with RLS off. On existing Supabase projects, new public tables also grant anon, authenticated and service_role full privileges, so the table is open through the API until you enable RLS.",
        },
        {
          title: "A stronger key used to make a failing query pass",
          detail:
            "A query that fails under RLS can tempt a quick fix with a stronger key. A sb_secret_ key maps to service_role and skips RLS, so in an EXPO_PUBLIC_ or VITE_ variable it hands every user full access. Supabase is deprecating the legacy service_role JWT key by the end of 2026, so check for both key formats.",
        },
        {
          title: "Security definer functions in the public schema",
          detail:
            "If Windsurf's agent writes a security definer function to get around a policy, the function runs as its owner and skips RLS for every caller who can execute it. Security Advisor lints 0028 and 0029 flag these functions. Move them to a private schema and grant execute only where needed.",
        },
      ],
      howSupahoundHelps: [
        "The free posture scan checks RLS coverage on every connected project and lists newly exposed tables, so a Windsurf migration that left RLS off appears in the next daily scan.",
        "Security Advisor findings, including the security definer lints, appear in the same scan.",
        "The service-key detector alerts from day one when a secret key is used from a browser or from a network the project has not seen.",
        "The cross-tenant read detector flags a signed-in user reading rows that belong to other users or tenants, which is what a too-broad policy looks like in traffic.",
        "Supahound reads the Supabase project, not the editor, so monitoring keeps working if you switch from Windsurf to another tool.",
      ],
      faqs: [
        {
          q: "Does Windsurf have a built-in Supabase integration?",
          a: "Not a built-in one. You add Supabase's hosted MCP server at https://mcp.supabase.com/mcp from the Customize > MCPs page or in .devin/mcp_config.json, and sign in with OAuth. The agent then works with whatever Supabase code your repository has.",
        },
        {
          q: "Why do Windsurf's docs open on docs.devin.ai?",
          a: "docs.windsurf.com now redirects to docs.devin.ai/desktop, where Cognition documents the editor under the Devin Desktop name. The MCP setup that Supabase's guide refers to is described there.",
        },
        {
          q: "Which Supahound alerts start as soon as I connect?",
          a: "Cross-tenant reads, service-key misuse, credential stuffing and database tampering alert from day one. Behavioral detectors such as scraping learn your traffic for 7 days before they alert.",
        },
      ],
    },
    guide: {
      title: "How to secure a Supabase project you build in Windsurf",
      description:
        "Add the Supabase MCP server to Windsurf with one project and read-only mode, keep secret keys out of the client, and enable RLS in every migration.",
      h1: "How to secure Supabase when Windsurf's agent writes the code",
      intro:
        "Windsurf's Supabase access lives in one place: the MCP entry on its Customize > MCPs page or in .devin/mcp_config.json. Make that entry one project, read-only, signed in with OAuth rather than a key. The agent's migrations are your other exposure. Each create table needs its RLS statement beside it, and the build must fail if a secret key reaches the client.",
      sections: [
        {
          heading: "Where do I add the Supabase MCP server in Windsurf?",
          steps: [
            "Open the Customize > MCPs page, or edit .devin/mcp_config.json.",
            "Add Supabase's hosted server, https://mcp.supabase.com/mcp, and sign in with OAuth.",
            "Scope the server to one project and turn on read-only mode, as Supabase's MCP guide describes.",
            "Point it at a development project. Connect production only for a task that needs it.",
          ],
          paragraphs: ["docs.windsurf.com now redirects to docs.devin.ai/desktop, so look there for current MCP instructions."],
        },
        {
          heading: "What access should Windsurf's agent never have?",
          bullets: [
            "A service_role or sb_secret_ key in .devin/mcp_config.json or in a chat message.",
            "Write access to production during routine work.",
            "Broad rights while it reads user-submitted text. In a General Analysis research demo, hidden instructions in a support ticket made a Cursor agent with service_role access copy a private table.",
          ],
        },
        {
          heading: "How do I keep Supabase secret keys out of Windsurf-built client code?",
          paragraphs: [
            "The browser gets the publishable key (sb_publishable_) and nothing stronger. Supabase answers a secret key sent from a browser with HTTP 401, but the key still works from any script that copies it out of your bundle. Fail the build if a secret key appears in the output.",
          ],
          code: [
            {
              lang: "bash",
              code: "# Stop the deploy if a secret key reached the build output.\nif grep -rqE \"sb_secret_|service_role\" dist/ build/ .next/static/ 2>/dev/null; then\n  echo \"Secret Supabase key found in the build\" >&2\n  exit 1\nfi",
            },
          ],
        },
        {
          heading: "How do I make Windsurf's agent write migrations with RLS?",
          paragraphs: [
            "State the rule in the request: enable RLS in the same migration that creates the table, and add policies for the authenticated role. Supabase also notes that RLS can be enabled automatically on new tables with an event trigger.",
          ],
          code: [
            {
              lang: "sql",
              code: "create table public.tasks (\n  id bigint generated always as identity primary key,\n  user_id uuid not null references auth.users (id) on delete cascade,\n  title text not null,\n  done boolean not null default false\n);\nalter table public.tasks enable row level security;\n\ncreate policy \"tasks: owner reads\" on public.tasks\n  for select to authenticated\n  using ((select auth.uid()) = user_id);\n\ncreate policy \"tasks: owner updates\" on public.tasks\n  for update to authenticated\n  using ((select auth.uid()) = user_id)\n  with check ((select auth.uid()) = user_id);",
              caption: "Add insert and delete policies the same way if the app needs them.",
            },
          ],
        },
        {
          heading: "What should I check before I merge an agent-written migration?",
          steps: [
            "Run the RLS-off query on a development project and expect zero rows.",
            "List what anon and authenticated may do on each public table. Every grant should be one you meant.",
            "Open Security Advisor and fix every ERROR, including lints 0013 and 0010.",
          ],
          code: [
            { lang: "sql", code: RLS_OFF_QUERY },
            {
              lang: "sql",
              code: "-- Table privileges held by the API roles.\nselect table_name, grantee, string_agg(privilege_type, ', ') as privileges\nfrom information_schema.role_table_grants\nwhere table_schema = 'public' and grantee in ('anon', 'authenticated')\ngroup by table_name, grantee\norder by table_name, grantee;",
            },
          ],
        },
      ],
      faqs: [
        {
          q: "Is the Supabase MCP server safe to use in Windsurf?",
          a: "It is as safe as the access you give it. Supabase names prompt injection as the main LLM-specific attack and recommends project scoping, read-only mode for unattended work and production access only when a task needs it. Apply all three when you add the server.",
        },
        {
          q: "Does Windsurf scan my Supabase project for RLS problems?",
          a: "Windsurf documents no built-in RLS generation or Supabase scan. Run Security Advisor in the Supabase dashboard, or the RLS-off query in this guide, before each release.",
        },
        {
          q: "What does Supahound add after a Windsurf project launches?",
          a: "A daily posture scan of RLS coverage and views, and on paid plans a read of your edge logs every 1–2 minutes with per-user detectors. Findings arrive by email or signed webhook with a SQL fix.",
        },
      ],
    },
    sources: [
      { label: "Devin Desktop docs: Cascade MCP integration", url: "https://docs.devin.ai/desktop/cascade/mcp" },
      { label: "Windsurf docs: Cascade MCP (now redirects to Devin Desktop docs)", url: "https://docs.windsurf.com/windsurf/cascade/mcp" },
      SB.mcp,
      GENERAL_ANALYSIS,
      SB.tables,
      SB.securing,
      SB.keys,
      SB.rls,
      SB.advisors,
    ],
  },

  // ---------------------------------------------------------------- Claude Code
  {
    slug: "claude-code",
    name: "Claude Code",
    url: "https://code.claude.com/docs",
    kind: "ai-editor",
    integration: "supported",
    oneLine: "Anthropic's terminal coding agent that edits code, runs commands and calls MCP tools.",
    checked: CHECKED,
    landing: {
      title: "Supabase monitoring for apps built with Claude Code",
      description:
        "Claude Code runs commands in your terminal and can reach Supabase through its MCP server. Supahound watches what then reaches your database.",
      h1: "Monitor the Supabase project your Claude Code agent works on",
      intro:
        "Claude Code works from your terminal and runs the commands it writes. Its MCP docs ask you to trust every server you add, because a server that fetches outside content can carry prompt injection, and your Supabase rows count as outside content. Add Supabase's server read-only and scoped to one project. Supahound then scans that project's RLS daily for free and watches live traffic for a leaked secret key.",
      risks: [
        {
          title: "An MCP server you have not limited",
          detail:
            "You add Supabase with a claude mcp add command or a .mcp.json file and authenticate through /mcp. Claude Code's MCP docs tell you to trust each server, because a server that fetches outside content can carry prompt injection. Rows your users wrote are outside content too, so scope the server to one project and keep it read-only.",
        },
        {
          title: "Migrations that run before anyone reads them",
          detail:
            "Claude Code runs commands, so it can write a migration and apply it in the same session. Tables created that way start with RLS off, and on existing projects new public tables grant anon and authenticated full privileges. Read the SQL before it runs.",
        },
        {
          title: "A secret key behind a public prefix",
          detail:
            "If a change the agent makes puts a sb_secret_ or legacy service_role key under a NEXT_PUBLIC_ or EXPO_PUBLIC_ name, the key ships to every user. It maps to service_role, which bypasses RLS on every table, and Supabase's browser check does not stop someone who replays it from a server.",
        },
        {
          title: "A dashboard view that ignores RLS",
          detail:
            "A view the agent adds to simplify a report is created as security definer by default and is usually owned by postgres, so it ignores RLS on the tables under it. Security Advisor reports this as lint 0010 at level ERROR. Set security_invoker = on.",
        },
      ],
      howSupahoundHelps: [
        "The posture scan checks every connected project daily for RLS coverage, views without security_invoker and newly exposed tables, free for up to 3 projects.",
        "The service-key detector flags a secret key used from a browser or from a network the project has not used before, starting on day one.",
        "Database tampering alerts also start on day one, with no learning period.",
        "Each incident has a plain-English summary and a paste-ready SQL fix you can hand back to Claude Code to review.",
        "Alerts go to email or a signed webhook, and incident history stays for 30 days.",
      ],
      faqs: [
        {
          q: "Does Claude Code set up Supabase for me?",
          a: "No. Claude Code has no built-in Supabase flow. Supabase's MCP guide shows how to add its hosted server with claude mcp add or a .mcp.json file, then sign in with OAuth through /mcp.",
        },
        {
          q: "Should Claude Code run migrations against production?",
          a: "Supabase advises connecting an agent to production only when a task needs it. Let Claude Code run migrations against a development project, read the SQL, and promote it to production as a separate, reviewed step.",
        },
        {
          q: "What is the Supahound hack-me scan?",
          a: "A free external scan of your live site. It checks security headers, TLS and any Supabase keys shipped in public JavaScript. You prove you own the domain through DNS before it runs.",
        },
      ],
    },
    guide: {
      title: "How to secure Supabase when you build with Claude Code",
      description:
        "Add Supabase's MCP server to Claude Code with read-only access to one project, keep secret keys out of the client and review every RLS policy it writes.",
      h1: "How to use Claude Code with Supabase safely",
      intro:
        "Treat the Supabase MCP server the way Claude Code's own docs treat any server: trust it only as far as you must. Add it with claude mcp add or .mcp.json, sign in through /mcp, and keep it read-only on a single project. Because Claude Code runs commands, read each migration before it applies, test its policies as a real user, and check the names of your public env vars.",
      sections: [
        {
          heading: "How do I add the Supabase MCP server to Claude Code?",
          steps: [
            "Add https://mcp.supabase.com/mcp with a claude mcp add command or in .mcp.json. Supabase's MCP guide has the exact command.",
            "Run /mcp in Claude Code and sign in with OAuth.",
            "Scope the server to one project and turn on read-only mode.",
            "Use a development project. Connect production only for a task that needs it.",
          ],
        },
        {
          heading: "Why does prompt injection matter for a terminal agent?",
          paragraphs: [
            "Supabase's MCP guide names prompt injection as the primary LLM-specific attack. Claude Code's MCP docs give the same warning about any server that fetches external content. A row in your database can hold text that reads like an instruction.",
            "A General Analysis research demo showed the pattern with another editor: an agent connected as service_role read a support ticket and copied a private table into it. No customer breach was reported.",
          ],
          bullets: [
            "Keep the Supabase server read-only unless the current task writes.",
            "Never put a sb_secret_ or service_role key in .mcp.json.",
            "Read any SQL the agent wants to run while it is working with user data, before it runs.",
          ],
        },
        {
          heading: "How do I stop secret keys reaching the client?",
          bullets: [
            "Publishable key (sb_publishable_): maps to the anon or authenticated role. It is the only key client code should hold.",
            "Secret key (sb_secret_) or legacy service_role key: maps to service_role, which has BYPASSRLS. Keep it on servers and in Edge Functions.",
          ],
          code: [
            {
              lang: "bash",
              code: "# Print the names (not values) of every client-exposed variable.\ngrep -hoE \"^(NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_)[A-Z0-9_]+\" .env* 2>/dev/null | sort -u\n\n# Then confirm no secret key reached the build.\ngrep -rlE \"sb_secret_|service_role\" .next/static/ dist/ build/ 2>/dev/null",
              caption: "Each name in the first list must point to a public value. The second command should print nothing.",
            },
          ],
        },
        {
          heading: "What should I tell Claude Code when it writes a migration?",
          paragraphs: [
            "Ask for the RLS statement and the policies in the same migration as the table. Tables created with SQL do not get RLS on their own, and with RLS on but no policy, the API returns nothing, which tempts a too-broad fix later.",
          ],
          code: [
            {
              lang: "sql",
              code: "create table public.bookmarks (\n  id uuid primary key default gen_random_uuid(),\n  user_id uuid not null references auth.users (id) on delete cascade,\n  url text not null\n);\nalter table public.bookmarks enable row level security;\n\ncreate policy \"bookmarks: owner reads\" on public.bookmarks\n  for select to authenticated\n  using ((select auth.uid()) = user_id);\n\ncreate policy \"bookmarks: owner inserts\" on public.bookmarks\n  for insert to authenticated\n  with check ((select auth.uid()) = user_id);\n\ncreate policy \"bookmarks: owner deletes\" on public.bookmarks\n  for delete to authenticated\n  using ((select auth.uid()) = user_id);",
            },
          ],
        },
        {
          heading: "How do I test a generated policy before applying it?",
          steps: [
            "Apply the migration to a development project.",
            "Run the test below as a real user ID and confirm it sees only that user's rows.",
            "Run the RLS-off query and expect zero rows.",
            "Open Security Advisor and fix every ERROR before you promote the migration.",
          ],
          code: [
            {
              lang: "sql",
              code: "begin;\nset local role authenticated;\nselect set_config('request.jwt.claims', '{\"sub\":\"00000000-0000-0000-0000-000000000001\",\"role\":\"authenticated\"}', true);\nselect count(*) from public.bookmarks;  -- only this user's rows\nrollback;",
            },
            { lang: "sql", code: RLS_OFF_QUERY },
          ],
        },
      ],
      faqs: [
        {
          q: "Can Claude Code read my Supabase data through MCP?",
          a: "Yes, if the server you add has access to the project. That is why Supabase recommends read-only mode and one project, and why Claude Code's docs ask you to trust each server before you add it.",
        },
        {
          q: "How do I find tables without RLS in a Claude Code project?",
          a: "Run the RLS-off query from this guide in the SQL Editor and expect zero rows, or open Security Advisor and look for lint 0013. Supahound's posture scan repeats that check every day.",
        },
        {
          q: "What if a secret key already shipped to the browser?",
          a: "Rotate it in the Supabase dashboard, update every server that used it, then check your logs for what the old key did. Supahound's service-key detector watches for a key used from a browser or a new network.",
        },
      ],
    },
    sources: [
      { label: "Claude Code docs: Connect Claude Code to tools via MCP", url: "https://code.claude.com/docs/en/mcp" },
      SB.mcp,
      GENERAL_ANALYSIS,
      SB.tables,
      SB.securing,
      SB.keys,
      SB.advisors,
    ],
  },

  // ---------------------------------------------------------------- GitHub Copilot
  {
    slug: "github-copilot",
    name: "GitHub Copilot",
    url: "https://github.com/features/copilot",
    kind: "ai-editor",
    integration: "supported",
    oneLine: "GitHub's AI assistant and coding agent in IDEs, the CLI and GitHub.com.",
    checked: CHECKED,
    landing: {
      title: "Supabase monitoring for GitHub Copilot projects",
      description:
        "GitHub Copilot reaches Supabase through MCP in your IDE or the Copilot CLI. Supahound scans RLS daily and watches each user's traffic, read-only.",
      h1: "Monitor the Supabase backend of an app you write with GitHub Copilot",
      intro:
        "GitHub Copilot runs in your IDE, the Copilot CLI and GitHub.com, and each can hold its own Supabase MCP entry: .vscode/mcp.json, a server from an MCP registry, or ~/.copilot/mcp-config.json. Every entry needs project scoping and read-only mode, and the SQL Copilot writes still needs RLS. Supahound covers the project behind all of them with a free daily RLS scan and per-user detectors on live traffic.",
      risks: [
        {
          title: "Supabase MCP configured in more than one place",
          detail:
            "Copilot Chat reads MCP servers from the IDE, for example .vscode/mcp.json, or from an MCP registry. The Copilot CLI keeps its own list in ~/.copilot/mcp-config.json. Each file can hold a different Supabase connection, so check project scoping and read-only mode in every one.",
        },
        {
          title: "Copilot-written SQL tables with RLS off, then a policy that allows everything",
          detail:
            "Copilot has no built-in RLS generation or Supabase scan, and a table created with SQL starts with RLS off. Once you turn RLS on, the table returns no rows through the API until a policy allows them, and that gap tempts a policy that allows everything. Security Advisor flags these states as lints 0013, 0008 and 0024.",
        },
        {
          title: "A secret key shipped in a VITE_ or NEXT_PUBLIC_ variable",
          detail:
            "A sb_secret_ or service_role key in a client-exposed variable reaches every visitor of your Copilot-built app. Supabase answers a browser that sends a secret key with HTTP 401, but the same key still works from a server or script, and it bypasses RLS on every table.",
        },
        {
          title: "Views and functions that run as their owner",
          detail:
            "A view or security definer function added in a Copilot session runs with its owner's rights, so it can skip the RLS on the tables it reads. Security Advisor flags such views as lint 0010 and the functions under lints 0028 and 0029.",
        },
      ],
      howSupahoundHelps: [
        "The posture scan runs daily, free for up to 3 projects, and reports RLS coverage, Security Advisor findings and views without security_invoker.",
        "Newly exposed tables appear in the scan, so a public table Copilot added with RLS off gets flagged.",
        "The service-key detector alerts from day one when a secret key shows up in browser traffic or from a new network.",
        "The credential stuffing detector alerts from day one when someone tries lists of leaked passwords against your app's sign-in.",
      ],
      faqs: [
        {
          q: "Does GitHub Copilot connect to Supabase on its own?",
          a: "No. Copilot has no built-in Supabase flow. You add Supabase's MCP server in your IDE's MCP config, from an MCP registry, or in the Copilot CLI's ~/.copilot/mcp-config.json, then sign in with OAuth.",
        },
        {
          q: "Does Supabase document Copilot as a client?",
          a: "Yes. Supabase's MCP guide lists VS Code and the GitHub Copilot CLI as clients of its hosted server at https://mcp.supabase.com/mcp, and its AI prompts page names GitHub Copilot.",
        },
        {
          q: "Does Supahound need access to my GitHub repository?",
          a: "No. Supahound reads your Supabase project through read-only OAuth, so it works the same whether Copilot, a teammate or another tool wrote the code.",
        },
      ],
    },
    guide: {
      title: "How to secure Supabase when you code with GitHub Copilot",
      description:
        "Configure Supabase's MCP server for GitHub Copilot in VS Code or the CLI with one project and read-only mode, keep secret keys out and check every policy.",
      h1: "How to secure a Supabase app built with GitHub Copilot",
      intro:
        "Copilot can read Supabase's MCP server from three places: your IDE's MCP config, an MCP registry and the Copilot CLI's ~/.copilot/mcp-config.json. Audit each one for project scoping and read-only mode, and remove any service_role key. Then make Copilot pair every create table with RLS, hunt for policies that allow every row, and keep secret keys out of the bundle.",
      sections: [
        {
          heading: "Where does Copilot read its Supabase MCP config?",
          bullets: [
            "In the IDE: an MCP config such as .vscode/mcp.json, or a server added from an MCP registry.",
            "In the Copilot CLI: ~/.copilot/mcp-config.json, with OAuth through /mcp.",
            "Both point at Supabase's hosted server, https://mcp.supabase.com/mcp.",
          ],
          steps: [
            "Find every place your team configured the Supabase server.",
            "Scope each entry to one project and turn on read-only mode, as Supabase's MCP guide describes.",
            "Use a development project for daily work. Connect production only when a task needs it.",
          ],
        },
        {
          heading: "What access should Copilot's MCP connection have?",
          paragraphs: [
            "Supabase names prompt injection as the main LLM-specific attack on MCP. A General Analysis research demo showed why it matters: an agent in another editor, connected as service_role, followed hidden instructions in a support ticket and copied a private table. No customer breach was reported.",
          ],
          bullets: [
            "No service_role or sb_secret_ key in any MCP config file.",
            "Read-only by default. Writes only for the task that needs them.",
            "No broad access while Copilot reads text your users submitted.",
          ],
        },
        {
          heading: "How do I keep secret keys out of a Copilot-written frontend?",
          paragraphs: [
            "Client code holds the publishable key (sb_publishable_) only. Secret keys and legacy service_role keys stay on servers. Supabase is deprecating the legacy JWT keys by the end of 2026, so this is a good time to move to the new key format.",
          ],
          code: [
            {
              lang: "bash",
              code: "# Any output means a secret key is in a client variable or in the build.\ngrep -rlE \"(NEXT_PUBLIC_|VITE_|EXPO_PUBLIC_)[A-Z0-9_]*(SECRET|SERVICE)\" src/ app/ 2>/dev/null\ngrep -rlE \"sb_secret_|service_role\" .next/static/ dist/ build/ 2>/dev/null",
            },
          ],
        },
        {
          heading: "How do I ask Copilot for a migration with RLS?",
          paragraphs: [
            "Ask for the table, the RLS statement and the policies together. Name the role and the owner column so Copilot does not fall back to a policy that allows everything.",
          ],
          code: [
            {
              lang: "sql",
              code: "create table public.messages (\n  id bigint generated always as identity primary key,\n  sender_id uuid not null references auth.users (id) on delete cascade,\n  body text not null,\n  created_at timestamptz not null default now()\n);\nalter table public.messages enable row level security;\n\ncreate policy \"messages: sender reads\" on public.messages\n  for select to authenticated\n  using ((select auth.uid()) = sender_id);\n\ncreate policy \"messages: sender inserts\" on public.messages\n  for insert to authenticated\n  with check ((select auth.uid()) = sender_id);\n\ncreate index messages_sender_idx on public.messages (sender_id);",
            },
          ],
        },
        {
          heading: "How do I check Copilot's policies before they reach production?",
          steps: [
            "Run the query below and read every policy that allows all rows. Keep only the ones you meant, such as public read-only content.",
            "Run the RLS-off query and expect zero rows.",
            "Open Security Advisor and clear lints 0013, 0008, 0010 and 0024.",
          ],
          code: [
            {
              lang: "sql",
              code: "-- Policies that allow every row.\nselect tablename, policyname, cmd, roles\nfrom pg_policies\nwhere schemaname = 'public'\n  and (qual = 'true' or with_check = 'true');",
            },
            { lang: "sql", code: RLS_OFF_QUERY },
          ],
        },
      ],
      faqs: [
        {
          q: "Do VS Code and the Copilot CLI share one Supabase MCP setup?",
          a: "No. The IDE reads its own MCP config, such as .vscode/mcp.json, and the CLI reads ~/.copilot/mcp-config.json. Set project scoping and read-only mode in each.",
        },
        {
          q: "Can I use Supabase's AI prompts with Copilot?",
          a: "Supabase's AI prompts page names GitHub Copilot. Use those prompts as a starting point, and still review every policy Copilot writes before you apply it.",
        },
        {
          q: "Which check should I run last before deploying a Copilot project?",
          a: "Grep the production build for sb_secret_ and service_role and expect no output. Then run the RLS-off query against production and expect zero rows.",
        },
      ],
    },
    sources: [
      {
        label: "GitHub Docs: Extending Copilot Chat with MCP",
        url: "https://docs.github.com/en/copilot/how-tos/provide-context/use-mcp/extend-copilot-chat-with-mcp",
      },
      SB.mcp,
      { label: "Supabase: AI prompts", url: "https://supabase.com/docs/guides/getting-started/ai-prompts" },
      GENERAL_ANALYSIS,
      SB.rls,
      SB.keys,
      SB.advisors,
    ],
  },

  // ---------------------------------------------------------------- Anything
  {
    slug: "anything",
    name: "Anything",
    url: "https://www.anything.com",
    kind: "app-builder",
    integration: "supported",
    oneLine: "AI builder, formerly Create.xyz, for web and mobile apps with built-in Postgres, functions and auth.",
    checked: CHECKED,
    landing: {
      title: "Supabase monitoring for apps built with Anything",
      description:
        "Anything apps reach an external Supabase project through backend Functions. Supahound scans that project's RLS daily and flags a misused secret key.",
      h1: "Monitor the Supabase project behind your Anything app",
      intro:
        "Every Anything project gets a built-in Postgres database on Neon. Supabase is optional: Anything's docs say to use Functions to connect to an external database like Supabase. The risk sits in those Functions, because one that holds a secret key and skips its own checks gives every caller full access. Supahound watches that Supabase project's traffic and flags service-key misuse and bulk reads.",
      risks: [
        {
          title: "Functions that hold a secret key and check nothing",
          detail:
            "The documented Supabase path in Anything runs through Functions, so a Function usually holds the Supabase key. A sb_secret_ or service_role key bypasses RLS. A Function that forwards any request with that key returns any row to any caller.",
        },
        {
          title: "Functions anyone can call",
          detail:
            "A Function that proxies Supabase reads or writes and does not require a signed-in user turns your database into a public API. Check who can call each Anything Function before you publish.",
        },
        {
          title: "Supabase tables created by SQL without RLS",
          detail:
            "Anything documents no RLS generation or security scan for Supabase. Tables you or an agent create in the Supabase project with SQL start with RLS off, and Security Advisor rates that ERROR as lint 0013.",
        },
      ],
      howSupahoundHelps: [
        "The service-key detector alerts from day one when your secret key is used from a browser or a new network, which is what a key copied out of a Function looks like.",
        "After a 7-day learning period, the scraping and bulk-export detector flags an actor reading far more rows than its usual pattern.",
        "The free posture scan checks RLS coverage and Security Advisor findings in the Supabase project, separate from Anything's built-in database.",
        "Database tampering alerts run from day one, so unexpected writes and deletes in the Supabase project surface without a learning period.",
      ],
      faqs: [
        {
          q: "Does Anything use Supabase by default?",
          a: "No. Each Anything project gets a built-in PostgreSQL database on Neon, plus Functions and user accounts. You connect Supabase yourself through Functions. Supahound monitors only the Supabase project, not the built-in database.",
        },
        {
          q: "Is a Supabase key safe inside an Anything Function?",
          a: "A Function keeps the key off the client, which is the right place for it. A secret key still bypasses RLS there, so the Function must check who is calling and what they may read before it touches Supabase.",
        },
        {
          q: "Do I need Supahound if I only use Anything's built-in database?",
          a: "No. Supahound reads Supabase projects only. If your Anything app keeps everything in its built-in Neon database, there is nothing for Supahound to watch. It applies once a Function connects to Supabase.",
        },
        {
          q: "Were Anything apps in the Escape.tech vibe-coding study?",
          a: "Escape.tech's October 2025 scan of 5,600+ vibe-coded apps included about 449 Create.xyz apps and reported 2,000+ vulnerabilities and 400+ exposed secrets overall. The article does not break findings out per platform, so it is a reason to check your own app, not a verdict on Anything.",
        },
      ],
    },
    guide: {
      title: "How to secure Supabase in an Anything app",
      description:
        "Connect Supabase to an Anything app through backend Functions, keep the secret key there, check the caller in every Function and enable RLS on every table.",
      h1: "How to connect Supabase to Anything without opening your data",
      intro:
        "Anything gives each project a built-in Postgres database on Neon. To use Supabase instead, its docs point you to Functions: backend code that connects to an external database. Keep the Supabase key inside those Functions, require a signed-in user before a Function reads or writes, and enable RLS on every Supabase table so direct API calls find nothing.",
      sections: [
        {
          heading: "When does an Anything app need Supabase?",
          paragraphs: [
            "Often it does not. Anything's built-in database runs on Neon Postgres and comes with Functions and user accounts. Connect Supabase when you already run a Supabase project or need its features.",
            "Anything's docs describe one Supabase path: Functions that connect to the external database. They do not document calling Supabase from the client, so this guide assumes all Supabase traffic goes through Functions.",
          ],
        },
        {
          heading: "Which Supabase key should an Anything Function use?",
          bullets: [
            "Anything has its own user accounts. Unless your app signs users in with Supabase Auth, Supabase RLS cannot tell them apart, and the Function's own checks are the access control.",
            "A secret key (sb_secret_) maps to service_role, which has BYPASSRLS. Every Function that holds one must check the caller itself.",
            "Keep RLS on with no anon policy anyway. If the project URL or publishable key leaks, the tables stay closed.",
            "Store the key with the Function, never in client code.",
          ],
        },
        {
          heading: "What must every Function check before it touches Supabase?",
          bullets: [
            "The caller is signed in. Reject anonymous calls unless the data is public.",
            "The caller owns, or may see, the rows the Function returns.",
            "The Function takes no table name, column list or raw filter from the request.",
            "The Function limits how many rows one call can return.",
          ],
        },
        {
          heading: "How do I enable RLS in the Supabase project?",
          paragraphs: [
            "Turn RLS on in the same SQL that creates each table. With RLS on and no policy, the API returns nothing to the anon and authenticated roles, which is the safe default when only Functions read the data.",
          ],
          code: [
            {
              lang: "sql",
              caption: "Add the policies only if users sign in with Supabase Auth. Otherwise auth.uid() is empty and the enable statement alone is the right setup.",
              code: "create table public.bookings (\n  id uuid primary key default gen_random_uuid(),\n  guest_id uuid not null references auth.users (id) on delete cascade,\n  starts_at timestamptz not null\n);\nalter table public.bookings enable row level security;\n\ncreate policy \"bookings: guest reads\" on public.bookings\n  for select to authenticated\n  using ((select auth.uid()) = guest_id);\n\ncreate policy \"bookings: guest creates\" on public.bookings\n  for insert to authenticated\n  with check ((select auth.uid()) = guest_id);",
            },
          ],
        },
        {
          heading: "What should I check before publishing an Anything app?",
          steps: [
            "Call each Function while signed out. Every one that touches private data must refuse.",
            "Call each Function as user A and ask for user B's rows. It must return nothing.",
            "Run the RLS-off query in the Supabase SQL Editor and expect zero rows.",
            "Open Security Advisor and fix every ERROR.",
          ],
          code: [{ lang: "sql", code: RLS_OFF_QUERY }],
        },
      ],
      faqs: [
        {
          q: "Can I call Supabase directly from an Anything frontend?",
          a: "Anything's docs do not describe that pattern. They point to Functions for external databases like Supabase, so keep Supabase calls in Functions unless you have a documented reason not to.",
        },
        {
          q: "Does RLS help if my Function uses the secret key?",
          a: "Not for that Function. The secret key maps to service_role, which bypasses RLS, so the Function's own checks are the only guard. RLS still keeps the tables closed to anyone who calls the Supabase API directly with the publishable key.",
        },
        {
          q: "Which Supahound alert fits an open Anything Function?",
          a: "An open Function that someone scripts shows up as unusual read volume. The scraping and bulk-export detector flags that after it learns your normal traffic for 7 days.",
        },
      ],
    },
    sources: [
      { label: "Anything docs: Databases", url: "https://www.anything.com/docs/apps/databases" },
      { label: "Anything docs: Backend and Functions", url: "https://www.anything.com/docs/apps/backend" },
      { label: "Anything docs: full reference (llms-full.txt)", url: "https://www.anything.com/docs/llms-full.txt" },
      ESCAPE,
      SB.tables,
      SB.keys,
      SB.advisors,
    ],
  },

  // ---------------------------------------------------------------- Base44
  {
    slug: "base44",
    name: "Base44",
    url: "https://base44.com",
    kind: "app-builder",
    integration: "none",
    oneLine: "Wix-owned AI app builder with its own managed backend, database, auth and hosting.",
    checked: CHECKED,
    landing: {
      title: "Supabase monitoring for Base44 apps",
      description:
        "Base44 runs on its own managed backend. If you connect your own Supabase project from a backend function, Supahound scans its RLS and watches its traffic.",
      h1: "Monitor a Supabase project connected to your Base44 app",
      intro:
        "Base44 uses its own managed backend by default: database, user management, backend functions and hosting. Its docs do not mention Supabase. If you connect your own Supabase project, the calls run in backend functions you write, and a function that holds a secret key without checking the caller bypasses RLS. Supahound scans that Supabase project daily and flags a secret key used from a browser.",
      risks: [
        {
          title: "Backend functions with a secret key and no caller check",
          detail:
            "Base44 has no Supabase integration, so any Supabase call runs in a Base44 backend function. A function that uses a secret or service_role key without its own authorization checks bypasses RLS for whoever reaches it.",
        },
        {
          title: "A Supabase key pasted into frontend code",
          detail:
            "Base44 keeps secrets for backend functions. A Supabase key pasted into frontend code instead ships to the browser. Base44's security scan checks for exposed secrets, so run it before you publish, and keep sb_secret_ keys in Base44 secrets only.",
        },
        {
          title: "Supabase tables outside Base44's data permissions",
          detail:
            "Base44's data permissions govern its own managed backend, not an external Supabase project. Tables created there with SQL start with RLS off until you enable it, whatever your Base44 permissions say.",
        },
      ],
      howSupahoundHelps: [
        "If you connect a Supabase project, the free posture scan reports its RLS coverage and Security Advisor findings, a check Base44's scan list does not include.",
        "The service-key detector alerts from day one when a Supabase secret key is used from a browser or a network the project has not seen.",
        "The scraping and bulk-export detector learns for 7 days, then flags an actor that suddenly reads far more rows than before.",
        "Supahound reads the Supabase project through read-only OAuth, so it needs no access to your Base44 account.",
      ],
      faqs: [
        {
          q: "Does Base44 use Supabase?",
          a: "No. Base44 apps use Base44's managed backend and SDK, and its docs index does not mention Supabase. Supahound applies only if you connect your own Supabase project, usually from a backend function.",
        },
        {
          q: "Does Base44's security scan cover my Supabase project?",
          a: "Base44's scan checks its own permissions, user field access, private fields, exposed secrets, backend functions, dependencies and security headers. Its documented checks do not include RLS in an external Supabase project, so run Supabase's Security Advisor too.",
        },
        {
          q: "Was the 2025 Wiz finding on Base44 about Supabase?",
          a: "No. Wiz reported undocumented register and verify-otp endpoints that let anyone with a non-secret app_id create a verified account on private Base44 apps, bypassing SSO. Wix fixed it within 24 hours and reported no evidence of exploitation.",
        },
        {
          q: "What did Escape.tech's 2025 study find about Base44 apps?",
          a: "Escape.tech scanned over 5,600 public vibe-coded apps, about 159 of them on Base44, and reported its totals for the whole sample. The article does not break findings out per platform, so it says nothing specific about Base44 apps.",
        },
      ],
    },
    guide: {
      title: "How to secure Supabase in a Base44 app",
      description:
        "Base44 uses its own backend. If you connect Supabase, keep the key in Base44 secrets, check the caller in every backend function and enable RLS everywhere.",
      h1: "How to secure your own Supabase project in a Base44 app",
      intro:
        "Base44 apps run on Base44's managed backend by default and need no Supabase. If you connect your own Supabase project anyway, reach it only from a backend function, store its key in Base44 secrets, and make each function check who is calling. Enable RLS on every Supabase table, then run both Base44's security scan and Supabase's Security Advisor before you publish.",
      sections: [
        {
          heading: "Does a Base44 app need Supabase at all?",
          paragraphs: [
            "Most do not. Base44 provides a managed database, user management, backend functions and hosting, and controls access with data permissions you set by AI chat or by hand. Base44 docs say auth tokens are stored in the browser's localStorage.",
            "Connect Supabase only when you need data that already lives there. External services are reached through backend functions and API calls.",
          ],
        },
        {
          heading: "Where should the Supabase key live in a Base44 app?",
          steps: [
            "Store the Supabase key in Base44 secrets, never in frontend code.",
            "Call Supabase only from a backend function.",
            "Remember that Base44 users are not Supabase Auth users, so RLS cannot tell them apart. A function that holds a secret key (sb_secret_) bypasses RLS and must check the caller itself.",
            "Run Base44's security scan. It checks for exposed secrets.",
          ],
        },
        {
          heading: "What should a Base44 backend function check before it calls Supabase?",
          bullets: [
            "Who is calling. Refuse anonymous callers for private data.",
            "Which rows that caller may see. With a secret key, RLS will not do this for you.",
            "Which tables and filters the request may name. Never pass them through from the client.",
            "How many rows one call may return.",
          ],
        },
        {
          heading: "How do I enable RLS in the Supabase project?",
          paragraphs: [
            "Base44's data permissions do not reach Supabase. Enable RLS on each Supabase table. With no policy, the API returns nothing to anon and authenticated, so only your backend function can read the data.",
          ],
          code: [
            {
              lang: "sql",
              caption: "Add the policy only if the table's users sign in with Supabase Auth. Otherwise auth.uid() is empty; keep RLS on with no policy.",
              code: "alter table public.invoices enable row level security;\n\ncreate policy \"invoices: customer reads\" on public.invoices\n  for select to authenticated\n  using ((select auth.uid()) = customer_id);\n\ncreate index invoices_customer_idx on public.invoices (customer_id);",
            },
            { lang: "sql", code: RLS_OFF_QUERY },
          ],
        },
        {
          heading: "What do Base44's security checks cover?",
          bullets: [
            "Data permissions, user field access and private fields.",
            "Exposed secrets and backend functions.",
            "Dependencies and security headers, plus static analysis on the Builder plan and up.",
            "The publish panel shows security status. Fixes are not applied automatically. Wiz and Tenzai integrations are optional.",
          ],
          paragraphs: [
            "These checks cover Base44's own backend. For a Supabase project you connect, open Supabase's Security Advisor and clear lint 0013 (RLS disabled in public) and lint 0010 (security definer views).",
          ],
        },
      ],
      faqs: [
        {
          q: "Can I use Supabase Auth instead of Base44's user management?",
          a: "Base44's docs do not describe that. Base44 handles users itself. If you call Supabase from a backend function, you decide how that function identifies the caller, and that check is the one to test.",
        },
        {
          q: "Will Base44 fix a Supabase problem its scan finds?",
          a: "Base44's scan shows security status in the publish panel and does not apply fixes automatically. It is also not documented to look inside an external Supabase project.",
        },
        {
          q: "How do I know my Base44 backend function is not leaking Supabase data?",
          a: "Call it signed out and as a second user, and confirm both get nothing private. After launch, Supahound's service-key and bulk-export detectors watch the Supabase side.",
        },
      ],
    },
    sources: [
      { label: "Base44 docs: index (llms.txt)", url: "https://docs.base44.com/llms.txt" },
      { label: "Base44 docs: Security overview", url: "https://docs.base44.com/Setting-up-your-app/security-overview" },
      { label: "Base44 docs: Running a security scan", url: "https://docs.base44.com/Setting-up-your-app/running-a-security-scan" },
      { label: "Wiz: Critical vulnerability in Base44 (July 2025)", url: "https://www.wiz.io/blog/critical-vulnerability-base44" },
      ESCAPE,
      SB.tables,
      SB.keys,
      SB.advisors,
    ],
  },

  // ---------------------------------------------------------------- Firebase Studio
  {
    slug: "firebase-studio",
    name: "Firebase Studio",
    url: "https://firebase.google.com/docs/studio",
    kind: "app-builder",
    integration: "none",
    oneLine: "Google's browser-based agentic workspace for full-stack AI apps, which defaults to Firestore and Firebase Auth.",
    checked: CHECKED,
    landing: {
      title: "Supabase monitoring for Firebase Studio apps",
      description:
        "Firebase Studio sets up Firestore and Firebase Auth by default. If you add your own Supabase project, Supahound scans its RLS and watches its traffic.",
      h1: "Monitor a Supabase backend you added to a Firebase Studio app",
      intro:
        "Firebase Studio uses Firebase by default: when an app needs a database or sign-in, its App Prototyping agent sets up Cloud Firestore and Firebase Authentication. Supabase is not part of it. If you connect your own Supabase project, Firebase Security Rules do not protect it; Postgres RLS does. Supahound checks that project's RLS daily and watches its traffic for leaked keys and bulk reads.",
      risks: [
        {
          title: "Hand-added Supabase tables without RLS",
          detail:
            "Nothing in Firebase Studio creates Supabase tables for you, so every table comes from SQL you or the agent write. Tables made that way start with RLS off, and a public table without RLS lets anyone with the project URL read and change it.",
        },
        {
          title: "Expecting Security Rules to cover Supabase",
          detail:
            "Firebase protects its own services with Security Rules, not Postgres RLS. Supabase does not read those rules. Each Supabase table needs its own policies, and once RLS is on it returns no rows through the API until a policy allows them.",
        },
        {
          title: "A Supabase secret key in client code",
          detail:
            "Only the publishable key (sb_publishable_) belongs in a Firebase Studio app's client code. A sb_secret_ key maps to service_role, which has BYPASSRLS, so anyone who copies it from the bundle can read and write every table.",
        },
        {
          title: "Supabase Edge Functions with JWT checks turned off",
          detail:
            "If you add Supabase Edge Functions alongside a Firebase Studio app, keep JWT verification on. A function deployed with --no-verify-jwt or verify_jwt = false can be invoked by anyone.",
        },
      ],
      howSupahoundHelps: [
        "The free posture scan reports RLS coverage and newly exposed tables in the Supabase project every day.",
        "The service-key detector alerts from day one when a Supabase secret key is used from a browser or an unfamiliar network.",
        "If the app signs users in with Supabase Auth, the credential stuffing detector watches those sign-ins from day one.",
        "Supahound monitors only the Supabase project. It does not read Firestore or Firebase Authentication.",
      ],
      faqs: [
        {
          q: "Does Firebase Studio support Supabase?",
          a: "Its docs do not mention Supabase. The App Prototyping agent sets up Cloud Firestore and Firebase Authentication when an app needs them. Supabase is something you connect yourself.",
        },
        {
          q: "Can I still start a new Firebase Studio workspace?",
          a: "No. Google's docs say new workspace creation and user signup are no longer supported. Existing workspaces still work.",
        },
        {
          q: "Do Firebase Security Rules protect a Supabase project?",
          a: "No. Security Rules apply to Firebase services. A Supabase project relies on Postgres Row Level Security, which you enable and write for each table.",
        },
      ],
    },
    guide: {
      title: "How to secure Supabase in a Firebase Studio app",
      description:
        "Firebase Studio defaults to Firestore. If you connect your own Supabase project, use only the publishable key in the client and enable RLS on every table.",
      h1: "How to secure your own Supabase project in a Firebase Studio app",
      intro:
        "A Firebase Studio app runs on Cloud Firestore and Firebase Authentication by default, and its docs do not mention Supabase. When you add your own Supabase project, Security Rules no longer apply: Postgres RLS takes over. Ship only the publishable key, keep Edge Functions on JWT verification, and clear Security Advisor's RLS and view lints before you publish.",
      sections: [
        {
          heading: "Does a Firebase Studio app use Supabase?",
          paragraphs: [
            "Not by default. When an app needs a database or authentication, Firebase Studio's App Prototyping agent sets up Cloud Firestore and Firebase Authentication. Supabase only enters the app if you add it.",
            "Google's docs also say new workspace creation and user signup are no longer supported, while existing workspaces still work. This guide applies to those existing workspaces.",
          ],
        },
        {
          heading: "Which Supabase key can go in a Firebase Studio app?",
          bullets: [
            "Client code: the publishable key (sb_publishable_), which maps to the anon or authenticated role.",
            "Server code only: a secret key (sb_secret_), which maps to service_role and bypasses RLS.",
            "Legacy anon and service_role JWT keys: Supabase is deprecating them by the end of 2026. Use the new formats.",
          ],
          code: [{ lang: "bash", code: "# Expect no output: no secret key in the built client.\ngrep -rlE \"sb_secret_|service_role\" dist/ build/ .next/static/ 2>/dev/null" }],
        },
        {
          heading: "How do I protect Supabase tables without Security Rules?",
          paragraphs: [
            "Supabase uses Postgres RLS. Enable it on each table, then write one policy per command that names the role and checks ownership.",
          ],
          code: [
            {
              lang: "sql",
              code: "create table public.profiles (\n  id uuid primary key references auth.users (id) on delete cascade,\n  display_name text\n);\nalter table public.profiles enable row level security;\n\ncreate policy \"profiles: self reads\" on public.profiles\n  for select to authenticated\n  using ((select auth.uid()) = id);\n\ncreate policy \"profiles: self updates\" on public.profiles\n  for update to authenticated\n  using ((select auth.uid()) = id)\n  with check ((select auth.uid()) = id);",
            },
          ],
        },
        {
          heading: "How do I lock down Supabase Edge Functions?",
          paragraphs: [
            "Edge Functions require a valid JWT in the Authorization header by default. Keep it that way for anything that reads or writes private data. Search for places that turned it off.",
          ],
          code: [{ lang: "bash", code: "grep -rnE \"verify_jwt *= *false|no-verify-jwt\" supabase/ package.json 2>/dev/null" }],
        },
        {
          heading: "What should I check before publishing?",
          steps: [
            "Run the RLS-off query and expect zero rows.",
            "Open Security Advisor and clear lint 0013 (RLS disabled in public) and lint 0010 (security definer views).",
            "Grep the build for secret keys.",
            "Sign in as a test user and confirm you cannot read another user's rows.",
          ],
          code: [{ lang: "sql", code: RLS_OFF_QUERY }],
        },
      ],
      faqs: [
        {
          q: "Can I use Firebase Authentication with a Supabase database?",
          a: "Firebase Studio's docs do not cover that setup. If you try it, test every policy as a real signed-in user, because RLS policies decide access from the Supabase role and JWT claims.",
        },
        {
          q: "Does Security Advisor work for a Supabase project behind a Firebase Studio app?",
          a: "Yes. Security Advisor runs on the Supabase project, whatever frontend calls it. Open it before you publish and fix lint 0013 and lint 0010 first.",
        },
        {
          q: "What does Supahound check in a Firebase Studio setup?",
          a: "Only the Supabase project: its RLS coverage, Security Advisor findings, views and API traffic. Firestore and Firebase Authentication are outside what Supahound reads.",
        },
      ],
    },
    sources: [
      { label: "Firebase Studio documentation", url: "https://firebase.google.com/docs/studio" },
      SB.tables,
      SB.rls,
      SB.keys,
      SB.functions,
      SB.advisors,
    ],
  },

  // ---------------------------------------------------------------- Emergent
  {
    slug: "emergent",
    name: "Emergent",
    url: "https://emergent.sh",
    kind: "app-builder",
    integration: "none",
    oneLine: "Agentic platform that builds and publishes web and mobile apps on a managed MongoDB backend.",
    checked: CHECKED,
    landing: {
      title: "Supabase monitoring for apps built with Emergent",
      description:
        "Emergent apps run on managed MongoDB by default. If your agent wires in your own Supabase project, Supahound scans its RLS and watches each user's traffic.",
      h1: "Monitor a Supabase project connected to your Emergent app",
      intro:
        "Emergent builds apps on MongoDB that it manages, with Emergent Auth and Emergent Storage. Supabase is not in its integrations catalogue. If you ask the agent to use your own Supabase project, Emergent's docs say it will attempt the setup with standard REST APIs or SDKs, with no Supabase-specific guardrails. Supahound scans that project's RLS daily and flags a secret key used from a browser.",
      risks: [
        {
          title: "A Supabase setup no platform check reviews",
          detail:
            "For services outside its catalogue, Emergent's docs say the agent will attempt to configure them using standard REST APIs or SDKs. Emergent documents no guardrails for that Supabase setup, so review the keys, tables and policies the agent touched yourself.",
        },
        {
          title: "A secret key outside Emergent's runtime injection",
          detail:
            "Emergent injects integration secrets at runtime and says they are never exposed in logs or client-side code. A Supabase key placed where that injection does not apply, such as frontend code, ships to the browser, and a sb_secret_ key there bypasses RLS.",
        },
        {
          title: "Agent SQL that leaves new tables open",
          detail:
            "If Emergent's agent creates Supabase tables in SQL, none of them get RLS by default. Security Advisor marks each one as an ERROR under lint 0013, because until you fix it anyone with your project URL can create, read, update and delete those rows.",
        },
      ],
      howSupahoundHelps: [
        "The free posture scan checks the Supabase project for RLS coverage, newly exposed tables and views without security_invoker.",
        "The service-key detector alerts from day one when a Supabase secret key is used from a browser or a new network.",
        "If your Emergent app serves several customers from one Supabase project, the cross-tenant read detector flags a user reading another tenant's rows.",
        "Alerts go out by email and signed webhook, and Supahound keeps 30 days of incident history.",
      ],
      faqs: [
        {
          q: "Does Emergent support Supabase?",
          a: "Supabase is not in Emergent's integrations catalogue or on its MCP connectors page. Apps use MongoDB on a shared cluster that Emergent manages, with separate preview and production databases.",
        },
        {
          q: "Does Emergent's pre-publish health check cover Supabase?",
          a: "Emergent documents a pre-publish health check, but its docs do not describe checks on an external Supabase project. Run Supabase's Security Advisor on that project as well.",
        },
        {
          q: "Can I bring my own database to Emergent?",
          a: "Emergent supports bringing your own MongoDB Atlas. Supabase is not a listed option, so a Supabase connection is one the agent builds on request over REST or an SDK.",
        },
      ],
    },
    guide: {
      title: "How to secure Supabase in an Emergent app",
      description:
        "Emergent defaults to managed MongoDB. If you connect your own Supabase project, keep secret keys off the frontend and enable RLS on every table the agent makes.",
      h1: "How to secure your own Supabase project in an Emergent app",
      intro:
        "Emergent apps store data in MongoDB on a cluster Emergent manages, with Emergent Auth and Storage alongside, and Supabase is not one of its integrations. If you have the agent connect your own Supabase project, write the key rules into your prompt, then verify them: no secret key in frontend code, RLS on every table, and a clean Security Advisor run next to Emergent's health check.",
      sections: [
        {
          heading: "Should an Emergent app use Supabase?",
          paragraphs: [
            "Only if you have a reason. Emergent's managed MongoDB keeps preview and production data apart, and you can bring your own MongoDB Atlas. Supabase is not in the integrations catalogue, so any Supabase use is a custom setup the agent builds.",
          ],
        },
        {
          heading: "How do I tell Emergent's agent to set up Supabase safely?",
          paragraphs: ["Give the agent the rules before it writes code. A prompt like this one sets them."],
          code: [
            {
              lang: "text",
              code: "Connect this app to my Supabase project.\nUse only the publishable key (sb_publishable_) in frontend code.\nUse the secret key only in backend code, never in the frontend.\nEnable row level security on every table you create.\nIn backend code, check the signed-in user before every Supabase query.",
              caption: "Emergent Auth users are not Supabase Auth users, so RLS policies on auth.uid() only help if the app signs users in with Supabase Auth.",
            },
          ],
        },
        {
          heading: "Where does the Supabase secret key go in an Emergent app?",
          bullets: [
            "Emergent says integration secrets are injected at runtime and never exposed in logs or client-side code. Supabase is not a listed integration, so confirm where the agent put the key.",
            "The secret key (sb_secret_) belongs in backend code only. It maps to service_role and bypasses RLS.",
            "The frontend may hold the publishable key and nothing else.",
          ],
        },
        {
          heading: "How do I enable RLS on tables Emergent's agent creates?",
          paragraphs: [
            "Enable RLS on every table. With RLS on and no policy, the Supabase API returns nothing to anon and authenticated, so only backend code with the secret key can read the data.",
          ],
          code: [
            {
              lang: "sql",
              caption: "Add the policies only if buyers sign in with Supabase Auth. With Emergent Auth, keep RLS on with no policy and check the user in backend code.",
              code: "alter table public.orders enable row level security;\n\ncreate policy \"orders: buyer reads\" on public.orders\n  for select to authenticated\n  using ((select auth.uid()) = buyer_id);\n\ncreate policy \"orders: buyer creates\" on public.orders\n  for insert to authenticated\n  with check ((select auth.uid()) = buyer_id);",
            },
            { lang: "sql", code: RLS_OFF_QUERY },
          ],
        },
        {
          heading: "What should I check before I publish an Emergent app?",
          steps: [
            "Run Emergent's pre-publish health check.",
            "Run the RLS-off query on the Supabase project and expect zero rows.",
            "List what anon and authenticated may do on each public table, and revoke what you did not mean.",
            "Open Supabase's Security Advisor and fix every ERROR.",
          ],
          code: [
            {
              lang: "sql",
              code: "select table_name, grantee, privilege_type\nfrom information_schema.role_table_grants\nwhere table_schema = 'public' and grantee in ('anon', 'authenticated')\norder by table_name, grantee, privilege_type;",
            },
          ],
        },
      ],
      faqs: [
        {
          q: "Will Emergent's agent enable RLS by itself?",
          a: "Emergent's docs do not say so. Tables created with SQL start with RLS off in Supabase, so ask for RLS in your prompt and check the result with the RLS-off query.",
        },
        {
          q: "Is Emergent's runtime secret injection enough for a Supabase key?",
          a: "It covers Emergent's listed integrations. Supabase is not one of them, so check that the agent kept the secret key in backend code and out of the frontend bundle.",
        },
        {
          q: "How do I hear about Supabase problems after an Emergent app launches?",
          a: "Connect the Supabase project to Supahound. On paid plans it reads edge logs every 1–2 minutes and sends each incident by email or signed webhook with a SQL fix. Emergent's MongoDB stays outside its view.",
        },
      ],
    },
    sources: [
      { label: "Emergent help center", url: "https://help.emergent.sh" },
      { label: "Emergent: Database (MongoDB)", url: "https://help.emergent.sh/database-mongodb" },
      { label: "Emergent: Key integrations catalogue", url: "https://help.emergent.sh/key-integrations-catalogue" },
      { label: "Emergent: MCPs and connectors", url: "https://help.emergent.sh/mcps-connectors" },
      SB.tables,
      SB.securing,
      SB.keys,
      SB.advisors,
    ],
  },
];
