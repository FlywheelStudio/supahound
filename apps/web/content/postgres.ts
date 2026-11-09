// Postgres and Supabase best-practice guides (/guides/postgres/<slug>).
// Source of truth: the supabase-postgres skill and Supabase's documented RLS performance advice.
import type { Guide } from "./types";

const U = "2026-11-08";

export const postgresGuides: Guide[] = [
  {
    slug: "row-level-security",
    updated: U,
    meta: {
      title: "Supabase Row Level Security: a practical guide",
      description: "Turn on RLS, write one policy per command, test as a real user and avoid the five policy mistakes that leak data in Supabase apps.",
      h1: "Supabase Row Level Security: how to turn it on and get it right",
      intro:
        "Row Level Security (RLS) makes Postgres check a policy for every row a query touches. In Supabase, any table in an exposed schema without RLS is readable and writable by anyone who has your public anon key, and that key ships in every browser. Turn RLS on for every table, then add one policy per command that names the role and checks ownership.",
    },
    sections: [
      {
        heading: "Why does Supabase need RLS more than a normal backend?",
        paragraphs: [
          "Supabase exposes your tables through an auto-generated REST and GraphQL API. Your frontend calls that API directly with the anon (or publishable) key. There is no server code in between to check who may read what, so the database itself must do it. RLS is that check.",
          "With RLS on and no policies, the table returns no rows to the anon and authenticated roles. That is a safe default: you open access one policy at a time.",
        ],
      },
      {
        heading: "How do I turn RLS on?",
        paragraphs: ["Tables you create in the Table Editor have RLS on by default. Tables you create with SQL, including SQL an AI tool writes for you, do not. Turn it on in every migration."],
        code: [
          {
            lang: "sql",
            code: "alter table public.notes enable row level security;\n\n-- Optional: make the table owner obey RLS too.\nalter table public.notes force row level security;",
          },
          {
            lang: "sql",
            code: "-- Find every table in public without RLS.\nselect c.relname\nfrom pg_class c\njoin pg_namespace n on n.oid = c.relnamespace\nwhere n.nspname = 'public' and c.relkind = 'r' and not c.relrowsecurity;",
            caption: "Run this after every migration. It must return no rows.",
          },
        ],
      },
      {
        heading: "How do I write a policy that only lets users see their own rows?",
        paragraphs: [
          "Write one policy per command (select, insert, update, delete). Name the role with `to authenticated`, so anonymous visitors never run the policy. Use `using` for rows the user may see or change, and `with check` for the values a new or updated row may hold.",
        ],
        code: [
          {
            lang: "sql",
            code: "create policy \"notes: owner reads\" on public.notes\n  for select to authenticated\n  using ((select auth.uid()) = user_id);\n\ncreate policy \"notes: owner inserts\" on public.notes\n  for insert to authenticated\n  with check ((select auth.uid()) = user_id);\n\ncreate policy \"notes: owner updates\" on public.notes\n  for update to authenticated\n  using ((select auth.uid()) = user_id)\n  with check ((select auth.uid()) = user_id);\n\ncreate policy \"notes: owner deletes\" on public.notes\n  for delete to authenticated\n  using ((select auth.uid()) = user_id);",
          },
        ],
      },
      {
        heading: "What are the most common RLS mistakes?",
        bullets: [
          "`using (true)` on a table with private data. It looks like a policy, but it lets every signed-in user read every row.",
          "An update policy with `using` but no `with check`. A user can then move their row to another user by changing `user_id`.",
          "Trusting `auth.jwt() -> 'user_metadata'`. Users can edit their own user metadata. Put roles and team IDs in `app_metadata`, which only your server can set.",
          "Checking the owner on select but not on update or delete.",
          "Tables in `public` that the app never meant to expose. Move internal tables to a schema the API does not expose.",
        ],
      },
      {
        heading: "How do I test a policy?",
        paragraphs: ["Test as the role the browser uses, not in the SQL editor as `postgres`, which bypasses RLS. Inside a transaction, switch role and set the JWT claims, then query."],
        code: [
          {
            lang: "sql",
            code: "begin;\nset local role authenticated;\nselect set_config('request.jwt.claims', '{\"sub\":\"00000000-0000-0000-0000-000000000001\",\"role\":\"authenticated\"}', true);\nselect count(*) from public.notes;  -- only this user's rows\nrollback;",
          },
        ],
      },
    ],
    faqs: [
      { q: "Does the service_role key obey RLS?", a: "No. The service_role and secret keys use a role with BYPASSRLS, so they skip every policy. Use them only on a server, never in a browser or a mobile app." },
      { q: "Is RLS on by default in Supabase?", a: "For tables made in the Table Editor, yes. For tables made with SQL or migrations, no. Turn it on in the same migration that creates the table." },
      { q: "Can RLS be on and my data still leak?", a: "Yes. RLS is only as good as its policies. A `using (true)` policy or a missing owner check leaks data with RLS on. That is why Supahound also watches traffic for one user reading other users' rows." },
    ],
    related: ["rls-performance", "multi-tenant-rls", "api-keys"],
  },
  {
    slug: "rls-performance",
    updated: U,
    meta: {
      title: "Fast RLS policies in Supabase: 5 rules",
      description: "Make Supabase RLS fast: wrap auth.uid() in a select, index policy columns, name the role, avoid joins in policies and filter in the query too.",
      h1: "How to make Supabase RLS policies fast",
      intro:
        "Slow RLS usually comes from a policy function that Postgres runs once per row, or from a policy column with no index. Wrap `auth.uid()` and `auth.jwt()` in `(select ...)` so Postgres runs them once per query, index every column a policy filters on, and name the role with `to authenticated`.",
    },
    sections: [
      {
        heading: "Why wrap auth.uid() in a select?",
        paragraphs: [
          "`auth.uid()` is a function. In `using (auth.uid() = user_id)` Postgres may call it for every row. In `using ((select auth.uid()) = user_id)` the planner turns it into an init plan, runs it once and reuses the value. On large tables this is often the biggest single speed-up.",
        ],
        code: [{ lang: "sql", code: "-- Slow on big tables\nusing (auth.uid() = user_id)\n\n-- Fast\nusing ((select auth.uid()) = user_id)" }],
      },
      {
        heading: "Which columns need an index?",
        paragraphs: ["Every column a policy compares, such as `user_id`, `team_id` or `tenant_id`. Without the index, each query scans the whole table before RLS throws most rows away."],
        code: [{ lang: "sql", code: "create index notes_user_id_idx on public.notes (user_id);" }],
      },
      {
        heading: "Why name the role in a policy?",
        paragraphs: ["A policy without `to authenticated` also runs for the anon role. Naming the role lets Postgres skip the policy entirely for requests it does not apply to."],
      },
      {
        heading: "How do I check team membership without a slow join?",
        paragraphs: [
          "A policy that joins to a membership table runs that join for each row. Flip it: select the user's team IDs once, then test the row's team against that set. Put the lookup in a `security definer` function in a private schema if the membership table has its own RLS.",
        ],
        code: [
          {
            lang: "sql",
            code: "create policy \"docs: team members read\" on public.docs\n  for select to authenticated\n  using (team_id in (\n    select team_id from public.memberships\n    where user_id = (select auth.uid())\n  ));",
          },
        ],
      },
      {
        heading: "Should the query filter too?",
        paragraphs: ["Yes. Add the same filter in the client query, for example `.eq('user_id', userId)`. RLS stays the security boundary, and the explicit filter gives the planner a better plan."],
      },
    ],
    faqs: [
      { q: "How do I see if RLS is my bottleneck?", a: "Run `explain analyze` on the query as the authenticated role inside a transaction. Look for sequential scans on large tables and for a policy function called once per row." },
      { q: "Does wrapping auth.uid() change who can see what?", a: "No. The result is the same; Postgres just evaluates the function once per statement instead of once per row." },
      { q: "Are security definer functions safe in policies?", a: "They are safe if you keep them in a schema the API does not expose, set `search_path = ''`, and revoke execute from anon. They run with the owner's rights, so keep them small." },
    ],
    related: ["row-level-security", "indexing", "multi-tenant-rls"],
  },
  {
    slug: "multi-tenant-rls",
    updated: U,
    meta: {
      title: "Multi-tenant RLS for SaaS apps on Supabase",
      description: "Isolate teams and orgs in Supabase with a memberships table, tenant_id on every row, app_metadata claims and tests that prove one tenant cannot read another.",
      h1: "Multi-tenant RLS in Supabase: keep each team's data apart",
      intro:
        "Give every tenant-owned table a `tenant_id`, keep a `memberships` table that maps users to tenants, and write every policy as \"the row's tenant is one of my tenants\". Then test it: sign in as a user from tenant A and prove that every query for tenant B returns nothing.",
    },
    sections: [
      {
        heading: "What does the schema look like?",
        code: [
          {
            lang: "sql",
            code: "create table public.tenants (\n  id uuid primary key default gen_random_uuid(),\n  name text not null\n);\n\ncreate table public.memberships (\n  tenant_id uuid not null references public.tenants (id) on delete cascade,\n  user_id uuid not null references auth.users (id) on delete cascade,\n  role text not null check (role in ('owner', 'member')),\n  primary key (tenant_id, user_id)\n);\ncreate index memberships_user_idx on public.memberships (user_id);\n\ncreate table public.projects (\n  id uuid primary key default gen_random_uuid(),\n  tenant_id uuid not null references public.tenants (id) on delete cascade,\n  name text not null\n);\ncreate index projects_tenant_idx on public.projects (tenant_id);",
          },
        ],
      },
      {
        heading: "How do I write the tenant policy?",
        code: [
          {
            lang: "sql",
            code: "alter table public.projects enable row level security;\n\ncreate policy \"projects: members read\" on public.projects\n  for select to authenticated\n  using (tenant_id in (\n    select tenant_id from public.memberships where user_id = (select auth.uid())\n  ));\n\ncreate policy \"projects: members write\" on public.projects\n  for insert to authenticated\n  with check (tenant_id in (\n    select tenant_id from public.memberships where user_id = (select auth.uid())\n  ));",
          },
        ],
        paragraphs: ["The `with check` matters: without it, a user could insert a row into a tenant they do not belong to."],
      },
      {
        heading: "Where do cross-tenant leaks come from?",
        bullets: [
          "A new table added without `tenant_id` or without a policy.",
          "A view that runs as its owner and so skips RLS (see the security definer guide).",
          "An RPC function marked `security definer` that takes a tenant ID as a parameter and never checks membership.",
          "Tenant IDs read from `user_metadata`, which the user can change.",
        ],
      },
      {
        heading: "How do I prove tenants are isolated?",
        paragraphs: [
          "Write a test that creates two tenants with one user each, signs in as user A and tries to select, update and delete tenant B's rows through the API. Every attempt must return zero rows. Run it in CI, and add every new table to it. A test that lists tables from `pg_class` and fails when a table lacks `tenant_id` or RLS catches the most common regression.",
        ],
      },
    ],
    faqs: [
      { q: "Should I put the tenant ID in the JWT?", a: "You can put it in `app_metadata` through a custom access token hook, which saves a lookup. Never put it in `user_metadata`, because users can edit that." },
      { q: "One schema per tenant or tenant_id columns?", a: "For most SaaS apps, a `tenant_id` column with RLS is simpler to migrate and query. Schema-per-tenant makes sense only for strong isolation needs and a small number of large tenants." },
      { q: "How does Supahound help with multi-tenant apps?", a: "Supahound reads your RLS policies to learn who owns which rows, then watches the logs for one actor reading rows from many owners. That is the traffic pattern of a cross-tenant leak." },
    ],
    related: ["row-level-security", "rls-performance", "views-and-functions"],
  },
  {
    slug: "api-keys",
    updated: U,
    meta: {
      title: "Supabase API keys: anon vs service_role, safely",
      description: "Which Supabase key goes where: publishable and anon keys in the browser, secret and service_role keys only on servers, and what to do when one leaks.",
      h1: "Supabase API keys: which key goes where, and what to do when one leaks",
      intro:
        "The anon key (or the newer publishable key) is meant to be public and is safe only because RLS protects your tables. The service_role key (or the newer secret key) bypasses RLS completely and must never reach a browser, a mobile app or a public repo. If it does, rotate it at once and check your logs for what it did.",
    },
    sections: [
      {
        heading: "What is the difference between the keys?",
        bullets: [
          "Publishable key (`sb_publishable_...`) or legacy anon key: low privilege. It maps to the anon role, and to the authenticated role once a user signs in. Safe in the browser if RLS is right.",
          "Secret key (`sb_secret_...`) or legacy service_role key: full access that skips RLS. Use it only in server code, Edge Functions and background jobs.",
        ],
      },
      {
        heading: "How do service keys leak in AI-built apps?",
        bullets: [
          "An environment variable named with a public prefix such as `NEXT_PUBLIC_` or `VITE_`, which the bundler puts into client JavaScript.",
          "A prompt that asks the AI to \"make the query work\" when RLS blocks it, and the AI swaps in the service key.",
          "A key pasted into a chat, a screenshot or a committed `.env` file.",
        ],
        code: [{ lang: "bash", code: "# Search your build output for a secret key before you deploy.\ngrep -rE \"sb_secret_|service_role\" dist/ .next/static/ build/ 2>/dev/null" }],
      },
      {
        heading: "What do I do if my service key leaked?",
        steps: [
          "Rotate it now in the Supabase dashboard under API keys. With the new keys, create a new secret key and delete the old one; with legacy JWT keys, rotate the JWT secret.",
          "Update every server that used the old key.",
          "Check your API logs for requests made with the old key from networks you do not run, especially bulk selects and deletes.",
          "Check your tables for changes you did not make.",
        ],
      },
    ],
    faqs: [
      { q: "Is it safe to put the anon key in my frontend?", a: "Yes, that is its purpose. It is safe only if every table it can reach has correct RLS policies." },
      { q: "Can I tell if someone is using my service key?", a: "Supabase API logs record each request. Supahound learns which networks your service key normally comes from and alerts you when it shows up from a new network or a browser." },
      { q: "Should I move to the new publishable and secret keys?", a: "Yes for new projects. You can create and revoke secret keys one at a time, which makes rotation after a leak much less painful than rotating the JWT secret." },
    ],
    related: ["row-level-security", "views-and-functions", "connection-pooling"],
  },
  {
    slug: "views-and-functions",
    updated: U,
    meta: {
      title: "Secure Supabase views and security definer functions",
      description: "Stop Supabase views and RPC functions from bypassing RLS: use security_invoker views, a private schema, an empty search_path and revoked execute rights.",
      h1: "Views and functions that bypass RLS, and how to lock them down",
      intro:
        "A Postgres view runs with its owner's rights by default, so in Supabase a view on an RLS table can show every row to anyone. Create views `with (security_invoker = true)` so they obey the caller's RLS. Functions marked `security definer` also run as their owner: keep them in a private schema, set `search_path = ''` and grant execute only to the roles that need it.",
    },
    sections: [
      {
        heading: "Why do views leak data?",
        paragraphs: [
          "Views are usually owned by `postgres`, which bypasses RLS. Unless the view uses `security_invoker`, a select on the view returns rows the caller could never read from the table. The Supabase Security Advisor flags these as security definer views.",
        ],
        code: [
          { lang: "sql", code: "create view public.my_notes\nwith (security_invoker = true) as\n  select id, title, created_at from public.notes;\n\n-- Fix an existing view\nalter view public.my_notes set (security_invoker = true);" },
        ],
      },
      {
        heading: "When is a security definer function safe?",
        bullets: [
          "It lives in a schema the API does not expose, for example `private`.",
          "It sets `search_path = ''` and uses fully qualified names, so nobody can shadow a table or function.",
          "It checks the caller itself, with `auth.uid()`, before it returns data.",
          "`execute` is revoked from `public` and `anon` and granted only where needed.",
        ],
        code: [
          {
            lang: "sql",
            code: "create schema if not exists private;\n\ncreate function private.my_team_ids()\nreturns setof uuid\nlanguage sql stable security definer\nset search_path = ''\nas $$\n  select team_id from public.memberships where user_id = (select auth.uid());\n$$;\n\nrevoke execute on function private.my_team_ids() from public, anon;\ngrant execute on function private.my_team_ids() to authenticated;",
          },
        ],
      },
      {
        heading: "What about RPC functions in the public schema?",
        paragraphs: [
          "Every function in an exposed schema is callable through `/rest/v1/rpc/<name>` by anyone with the anon key, unless you revoke execute. Review each one: if it is `security definer`, it must check the caller. If it takes an ID as a parameter, it must check that the caller may use that ID.",
        ],
      },
    ],
    faqs: [
      { q: "Which Postgres version supports security_invoker views?", a: "Postgres 15 and later. Supabase projects run Postgres 15 or newer." },
      { q: "How do I find risky views and functions?", a: "Open the Security Advisor in the Supabase dashboard. It lists security definer views, tables without RLS and functions with a mutable search_path." },
      { q: "Does Supahound check this?", a: "Yes. The free posture scan lists views without security_invoker and newly exposed tables, alongside the Security Advisor findings." },
    ],
    related: ["row-level-security", "multi-tenant-rls", "schema-design"],
  },
  {
    slug: "indexing",
    updated: U,
    meta: {
      title: "Postgres indexing on Supabase: what to index",
      description: "Index foreign keys and RLS columns, pick B-tree, GIN or partial indexes, order composite columns right and confirm the plan with explain analyze.",
      h1: "Postgres indexing on Supabase: what to index and how to check it",
      intro:
        "Index every foreign key, every column an RLS policy filters on, and the columns your hot queries filter and sort by. Use B-tree for equality and ranges, GIN for jsonb and arrays, and partial indexes for queries that always filter the same way. Confirm each index with `explain analyze`.",
    },
    sections: [
      {
        heading: "Which indexes does every Supabase app need?",
        bullets: [
          "Foreign keys. Postgres does not index them for you, and joins and cascading deletes scan the child table without one.",
          "RLS columns such as `user_id`, `team_id` and `tenant_id`.",
          "Sort columns for feeds and lists, usually `created_at`.",
        ],
        code: [{ lang: "sql", code: "create index orders_customer_id_idx on public.orders (customer_id);\ncreate index orders_tenant_created_idx on public.orders (tenant_id, created_at desc);" }],
      },
      {
        heading: "Which index type should I use?",
        bullets: [
          "B-tree (the default): `=`, `<`, `>`, `between`, `order by`.",
          "GIN: jsonb containment (`@>`), arrays and full-text search.",
          "Partial: a query that always has the same filter, such as `where status = 'open'`.",
          "Expression: a query on a function of a column, such as `lower(email)`.",
        ],
        code: [
          { lang: "sql", code: "create index tickets_open_idx on public.tickets (created_at) where status = 'open';\ncreate index users_email_lower_idx on public.profiles (lower(email));\ncreate index events_payload_idx on public.events using gin (payload);" },
        ],
      },
      {
        heading: "How do I order the columns in a composite index?",
        paragraphs: ["Put equality columns first and the range or sort column last. An index on `(tenant_id, created_at)` serves `where tenant_id = $1 order by created_at desc`; an index on `(created_at, tenant_id)` does not serve it well."],
      },
      {
        heading: "How do I check that an index is used?",
        code: [{ lang: "sql", code: "explain (analyze, buffers)\nselect * from public.orders\nwhere tenant_id = '...' order by created_at desc limit 20;" }],
        paragraphs: ["Look for `Index Scan` or `Index Only Scan` on the table. A `Seq Scan` on a large table means the index is missing or does not match the query."],
      },
    ],
    faqs: [
      { q: "Can too many indexes hurt?", a: "Yes. Each index slows inserts and updates and uses disk. Drop indexes that `pg_stat_user_indexes` shows are never scanned." },
      { q: "Does Supabase suggest indexes?", a: "Yes. The Performance Advisor and the index_advisor extension in the dashboard suggest indexes for slow queries." },
      { q: "Should I index a boolean column?", a: "Rarely on its own. Use a partial index on the rare value instead, for example `where archived = false` if most rows are archived." },
    ],
    related: ["rls-performance", "pagination", "schema-design"],
  },
  {
    slug: "connection-pooling",
    updated: U,
    meta: {
      title: "Supabase connection pooling for serverless apps",
      description: "Use Supavisor transaction mode (port 6543) for serverless and edge functions, session mode for long-lived servers, and turn off prepared statements.",
      h1: "Supabase connection pooling: which connection string to use",
      intro:
        "Serverless and edge functions open many short connections, which can exhaust Postgres. Connect them through the Supavisor pooler in transaction mode on port 6543, and turn off prepared statements in your driver. Long-lived servers can use session mode on port 5432. The supabase-js client uses the HTTP API and needs no pooler.",
    },
    sections: [
      {
        heading: "Which connection string should I use?",
        bullets: [
          "supabase-js in the browser or a server: no database connection at all; it calls the REST API.",
          "Serverless functions, edge runtimes and short scripts: the pooler in transaction mode, port 6543.",
          "Long-lived servers and tools that need session features (prepared statements, `listen`, temporary tables): the pooler in session mode, port 5432, or the direct connection.",
          "Migrations and admin tools: the direct connection or session mode.",
        ],
      },
      {
        heading: "What breaks in transaction mode?",
        paragraphs: [
          "Each transaction may run on a different server connection, so anything that lives on a session does not carry over: named prepared statements, `set` without `local`, advisory session locks and `listen/notify`. Turn off prepared statements in your driver.",
        ],
        code: [
          { lang: "ts", code: "// postgres.js\nconst sql = postgres(process.env.DATABASE_URL!, { prepare: false });\n\n// Prisma: add ?pgbouncer=true to the 6543 URL" },
        ],
      },
      {
        heading: "How do I avoid connection leaks in serverless code?",
        bullets: [
          "Open a client per request (or per invocation) and close it, or use the platform's pooling binding.",
          "Keep pool sizes small, such as 1–5 per function instance.",
          "Never hold a transaction open across an external API call.",
        ],
      },
    ],
    faqs: [
      { q: "What is Supavisor?", a: "Supavisor is Supabase's connection pooler. It sits in front of Postgres and shares a small number of database connections among many clients." },
      { q: "Why do I get 'too many connections' errors?", a: "Usually serverless functions are connecting directly on port 5432 and each instance opens its own connections. Move them to the transaction-mode pooler on port 6543." },
      { q: "Does pooling affect RLS?", a: "No. RLS uses the role and JWT claims of each request. Supabase's API sets them per request, and your own code should set them per transaction with `set local`." },
    ],
    related: ["pagination", "indexing", "api-keys"],
  },
  {
    slug: "pagination",
    updated: U,
    meta: {
      title: "Fast pagination in Supabase: keyset over offset",
      description: "Replace offset pagination with keyset (cursor) pagination in Supabase and Postgres: faster deep pages, stable results and an index that matches.",
      h1: "Pagination in Supabase: use keyset, not offset",
      intro:
        "Offset pagination makes Postgres read and throw away every row before the page you want, so page 500 is slow. Keyset pagination asks for rows after the last one you saw, such as `created_at < cursor`, and stays fast at any depth with a matching index.",
    },
    sections: [
      {
        heading: "Why is offset slow?",
        paragraphs: ["`limit 20 offset 10000` reads 10,020 rows to return 20. Pages also shift when rows are inserted, so users see duplicates or miss rows. Supabase's `.range()` uses offset under the hood."],
      },
      {
        heading: "How do I write keyset pagination?",
        paragraphs: ["Sort by a unique, stable key. If `created_at` can repeat, add `id` as a tiebreaker and compare both."],
        code: [
          { lang: "sql", code: "select id, title, created_at\nfrom public.posts\nwhere (created_at, id) < ($1, $2)\norder by created_at desc, id desc\nlimit 20;\n\ncreate index posts_created_id_idx on public.posts (created_at desc, id desc);" },
          { lang: "ts", code: "const { data } = await supabase\n  .from(\"posts\")\n  .select(\"id, title, created_at\")\n  .lt(\"created_at\", cursor)\n  .order(\"created_at\", { ascending: false })\n  .limit(20);" },
        ],
      },
      {
        heading: "Does pagination matter for security?",
        paragraphs: [
          "Yes. Scrapers page through tables fast and deep. A hard `limit` on every query, a max page size in your API settings and an index-backed cursor make bulk export slower and more visible. Supahound flags an actor that pages through a table far deeper or faster than your app does.",
        ],
      },
    ],
    faqs: [
      { q: "Can I jump to page 50 with keyset pagination?", a: "Not directly. Keyset suits infinite scroll and next/previous buttons. If you need numbered pages on large tables, show approximate counts and limit how deep users can jump." },
      { q: "How do I get a total count cheaply?", a: "Exact counts on large tables are slow. Use `count: 'estimated'` in supabase-js, which reads the planner's estimate." },
      { q: "Does Supabase cap rows per request?", a: "Yes. The API has a max rows setting (1,000 by default) in the project's API settings. Keep it as low as your app allows." },
    ],
    related: ["indexing", "connection-pooling", "row-level-security"],
  },
  {
    slug: "schema-design",
    updated: U,
    meta: {
      title: "Postgres schema design rules for Supabase apps",
      description: "Schema rules for Supabase: uuid keys, timestamptz, numeric for money, check constraints, jsonb, private schemas and RLS in the same migration.",
      h1: "Postgres schema design for Supabase apps: rules that prevent bugs",
      intro:
        "Use `uuid` primary keys, `timestamptz` for every time, `numeric` for money, `not null` and `check` constraints for every rule you can state, and `jsonb` only for truly unstructured data. Keep internal tables out of the exposed `public` schema, and turn on RLS in the same migration that creates each table.",
    },
    sections: [
      {
        heading: "Which column types should I use?",
        bullets: [
          "Primary keys: `uuid default gen_random_uuid()`. IDs are not guessable and can be made on the client.",
          "Times: `timestamptz`, never `timestamp`, so time zones never shift your data.",
          "Money: `numeric(12,2)` or integer cents, never `float`.",
          "JSON: `jsonb`, not `json`, and only for data with no fixed shape.",
          "Status fields: `text` with a `check` constraint, which is easier to change than an enum type.",
        ],
        code: [
          { lang: "sql", code: "create table public.invoices (\n  id uuid primary key default gen_random_uuid(),\n  tenant_id uuid not null references public.tenants (id) on delete cascade,\n  amount numeric(12,2) not null check (amount >= 0),\n  status text not null default 'draft' check (status in ('draft', 'sent', 'paid', 'void')),\n  created_at timestamptz not null default now()\n);\ncreate index invoices_tenant_idx on public.invoices (tenant_id);\nalter table public.invoices enable row level security;" },
        ],
      },
      {
        heading: "What belongs in the public schema?",
        paragraphs: [
          "Supabase exposes the `public` schema through its API. Put only the tables your frontend reads there. Audit logs, job queues, webhook payloads and anything only the server touches belong in a separate schema that is not in the API's exposed schemas list.",
        ],
        code: [{ lang: "sql", code: "create schema if not exists internal;\ncreate table internal.webhook_events (\n  id text primary key,\n  payload jsonb not null,\n  received_at timestamptz not null default now()\n);" }],
      },
      {
        heading: "Why put constraints in the database?",
        paragraphs: [
          "AI-generated frontends call your tables directly. Any rule that lives only in client code can be skipped by a user with the anon key and curl. `not null`, `check`, `unique` and foreign keys hold no matter who writes the row.",
        ],
      },
    ],
    faqs: [
      { q: "uuid or bigint identity keys?", a: "Both work. `uuid` hides row counts and can be made on the client. `bigint generated always as identity` is smaller and faster to index. For tables exposed to the browser, `uuid` avoids guessable IDs." },
      { q: "Should I use Postgres enums?", a: "Text with a `check` constraint is easier to change later. Enum types need a migration to add or remove values and cannot easily drop a value." },
      { q: "How do I stop AI tools from creating unsafe tables?", a: "Ask for migrations that include `enable row level security` and policies for every new table, then run the RLS check query from the RLS guide after every change." },
    ],
    related: ["row-level-security", "indexing", "views-and-functions"],
  },
];

export const postgresGuide = (slug: string) => postgresGuides.find((g) => g.slug === slug);
