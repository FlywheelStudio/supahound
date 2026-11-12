import type { ProjectTier } from "@supahound/core/db/billing";
import type { ProjectSummary } from "@supahound/core/db/repo";
import type { Role } from "@supahound/core/db/user";
import type { TenantId } from "@supahound/core/tenancy/scope";
import Link from "next/link";
import { PRODUCT_NAME } from "../lib/brand";
import {
  canAddProjects, initialOf, projectNav, projectPath, workspaceNav, workspacePath,
  type NavGroup, type ProjectPage, type WorkspacePage,
} from "../lib/nav";

// The signed-in shell (issue #98): a sidebar whose header is the project switcher, then the
// current project's pages, then the workspace pages. Every page renders it with data from its
// own membership transaction; there is no layout-level data fetch, so the shell is never the
// access check. Server-rendered, no client JavaScript: the switcher is a <details> element.

export type ShellActive =
  | { kind: "project"; project: ProjectSummary; page: ProjectPage }
  | { kind: "workspace"; page: WorkspacePage | null };

export interface ShellProps {
  tenant: TenantId;
  role: Role;
  projects: ProjectSummary[];
  tiers: ProjectTier[];
  billingOn: boolean;
  active: ShellActive;
  children: React.ReactNode;
}

function PlanBadge({ tier }: { tier: ProjectTier | undefined }) {
  if (!tier) return null;
  return (
    <span className={`rounded px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide ${tier.tier === "pro" ? "bg-emerald-100 text-emerald-800" : "bg-slate-100 text-slate-600"}`}>
      {tier.tier === "pro" ? "Pro" : "Starter"}
    </span>
  );
}

function Tile({ name }: { name: string }) {
  return (
    <span aria-hidden className="flex h-8 w-8 shrink-0 items-center justify-center rounded-md bg-slate-950 text-sm font-semibold text-white">
      {initialOf(name)}
    </span>
  );
}

function ProjectSwitcher({ tenant, role, projects, tiers, billingOn, active }: Omit<ShellProps, "children">) {
  const current = active.kind === "project" ? active.project : null;
  const tierOf = (id: string) => (billingOn ? tiers.find((t) => t.id === id) : undefined);
  return (
    // key: a new project or page remounts the element, so the menu closes after a switch.
    <details key={`${current?.id ?? "ws"}-${active.page ?? ""}`} className="group relative">
      <summary
        aria-label={current ? `Project: ${current.name}. Switch project` : "Switch project"}
        className="flex cursor-pointer list-none items-center gap-3 rounded-md border border-slate-200 bg-white p-2 hover:bg-slate-50 [&::-webkit-details-marker]:hidden"
      >
        {current ? (
          <>
            <Tile name={current.name} />
            <span className="min-w-0 flex-1">
              <span className="flex items-center gap-2">
                <span className="truncate font-medium">{current.name}</span>
                <PlanBadge tier={tierOf(current.id)} />
              </span>
              <span className="block truncate font-mono text-xs text-slate-500">{current.supabaseRef}</span>
            </span>
          </>
        ) : (
          <span className="flex-1 px-1 font-medium">All projects</span>
        )}
        <span aria-hidden className="text-slate-400 transition group-open:rotate-180">▾</span>
      </summary>
      <div className="absolute left-0 right-0 z-20 mt-1 rounded-md border border-slate-200 bg-white p-1 shadow-lg">
        <p className="px-2 py-1 text-xs font-medium text-slate-500">Switch project</p>
        <ul aria-label="Projects">
          <li>
            <Link href={workspacePath(tenant)} className="block rounded px-2 py-1.5 text-sm hover:bg-slate-100" aria-current={current ? undefined : "page"}>
              All projects
            </Link>
          </li>
          {projects.map((p) => (
            <li key={p.id}>
              <Link
                href={projectPath(tenant, p.id)}
                aria-current={p.id === current?.id ? "page" : undefined}
                className={`flex items-center gap-2 rounded px-2 py-1.5 text-sm hover:bg-slate-100 ${p.id === current?.id ? "bg-slate-100 font-medium" : ""}`}
              >
                <span className="truncate">{p.name}</span>
                <span className="ml-auto"><PlanBadge tier={tierOf(p.id)} /></span>
              </Link>
            </li>
          ))}
        </ul>
        {canAddProjects(role) && (
          <Link href={workspacePath(tenant, "projects")} className="mt-1 block border-t border-slate-100 px-2 py-1.5 text-sm text-slate-700 hover:bg-slate-100">
            + Add project
          </Link>
        )}
      </div>
    </details>
  );
}

function Group({ group }: { group: NavGroup }) {
  return (
    // Phones: a wrapped row of links with no group labels, so the page starts above the fold.
    <div className="mt-2 md:mt-4">
      {group.label && <p className="mb-1 hidden px-2 text-xs font-semibold uppercase tracking-wide text-slate-500 md:block">{group.label}</p>}
      <ul className="flex flex-wrap gap-1 md:block">
        {group.items.map((i) => (
          <li key={i.href}>
            <Link
              href={i.href}
              aria-current={i.current ? "page" : undefined}
              className={`flex items-center justify-between gap-2 rounded-md px-2 py-1.5 text-sm ${i.current ? "bg-slate-200 font-medium text-slate-950" : "text-slate-700 hover:bg-slate-100"}`}
            >
              {i.label}
              {i.soon && <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Soon</span>}
            </Link>
          </li>
        ))}
      </ul>
    </div>
  );
}

export function Shell(props: ShellProps) {
  const { tenant, billingOn, active, children } = props;
  const groups = active.kind === "project" ? projectNav(tenant, active.project.id, active.page) : [];
  return (
    <div className="min-h-screen md:flex">
      <aside className="border-b border-slate-200 bg-slate-50 p-4 md:sticky md:top-0 md:h-screen md:w-64 md:shrink-0 md:overflow-y-auto md:border-b-0 md:border-r">
        <p className="mb-3 px-2 text-sm font-semibold">{PRODUCT_NAME}</p>
        <ProjectSwitcher {...props} />
        <nav aria-label="Main">
          {groups.map((g) => <Group key={g.label ?? "project"} group={g} />)}
          <Group group={workspaceNav(tenant, active.kind === "workspace" ? active.page : null, billingOn)} />
        </nav>
        <form action="/auth/signout" method="post" className="mt-2 px-2 md:mt-6">
          <button className="text-sm text-slate-600 hover:text-slate-950">Sign out</button>
        </form>
      </aside>
      <main className="min-w-0 flex-1 px-4 py-8 md:px-10">
        <div className="mx-auto max-w-4xl">{children}</div>
      </main>
    </div>
  );
}

export function Notice({ tone, children }: { tone: "ok" | "error"; children: React.ReactNode }) {
  return (
    <p role="status" className={`mb-6 rounded-md border p-3 text-sm ${tone === "ok" ? "border-emerald-200 bg-emerald-50 text-emerald-900" : "border-red-200 bg-red-50 text-red-900"}`}>
      {children}
    </p>
  );
}

const SEVERITY_STYLE: Record<string, string> = {
  critical: "bg-red-100 text-red-800",
  high: "bg-orange-100 text-orange-800",
  medium: "bg-amber-100 text-amber-800",
  low: "bg-slate-100 text-slate-700",
};

export function SeverityBadge({ severity }: { severity: string }) {
  return <span className={`rounded px-2 py-0.5 text-xs font-semibold ${SEVERITY_STYLE[severity] ?? SEVERITY_STYLE.low}`}>{severity}</span>;
}

export function ComingSoon({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <section className="rounded-md border border-dashed border-slate-300 bg-white p-6">
      <p className="mb-2 flex items-center gap-2 font-semibold">
        {title}
        <span className="rounded bg-amber-100 px-1.5 py-0.5 text-[10px] font-semibold uppercase text-amber-800">Coming soon</span>
      </p>
      <div className="text-sm text-slate-700">{children}</div>
    </section>
  );
}
