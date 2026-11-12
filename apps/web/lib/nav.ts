import type { Role } from "@supahound/core/db/user";
import type { ProjectId, TenantId } from "@supahound/core/tenancy/scope";

// The navigation model for the sidebar shell (issue #98, decision 031). The URL holds the
// project, so a link is the whole state: nothing is remembered in a cookie or browser storage.
// Pure functions, so every branch is testable without a browser.

export type ProjectPage = "dashboard" | "incidents" | "findings" | "general" | "notifications" | "plan" | "people";
export type WorkspacePage = "overview" | "projects" | "billing" | "settings";

const PROJECT_SUFFIX: Record<ProjectPage, string> = {
  dashboard: "",
  incidents: "/incidents",
  findings: "/findings",
  general: "/settings",
  notifications: "/settings/notifications",
  plan: "/settings/plan",
  people: "/settings/people",
};

export function projectPath(tenant: TenantId, project: ProjectId, page: ProjectPage = "dashboard"): string {
  return `/w/${tenant}/p/${project}${PROJECT_SUFFIX[page]}`;
}

// One incident's detail page (issue #44). The nav marks "Incidents" as current there.
export function incidentPath(tenant: TenantId, project: ProjectId, incident: string): string {
  return `${projectPath(tenant, project, "incidents")}/${incident}`;
}

export function workspacePath(tenant: TenantId, page: WorkspacePage = "overview"): string {
  return page === "overview" ? `/w/${tenant}` : `/w/${tenant}/${page}`;
}

export interface NavItem {
  label: string;
  href: string;
  current: boolean;
  // Shown with a "Soon" badge: the page exists and says what is coming (decision 021 style).
  soon: boolean;
}

export interface NavGroup {
  label: string | null;
  items: NavItem[];
}

// Pages that are placeholders until their issue ships. Remove an entry when the page is real.
export const SOON: ReadonlySet<ProjectPage> = new Set<ProjectPage>(["findings"]);

const item = (label: string, href: string, current: boolean, soon = false): NavItem => ({ label, href, current, soon });

export function projectNav(tenant: TenantId, project: ProjectId, active: ProjectPage): NavGroup[] {
  const p = (page: ProjectPage, label: string) => item(label, projectPath(tenant, project, page), page === active, SOON.has(page));
  return [
    { label: null, items: [p("dashboard", "Dashboard"), p("incidents", "Incidents"), p("findings", "Security scan")] },
    { label: "Settings", items: [p("general", "General"), p("notifications", "Notifications"), p("plan", "Plan & billing"), p("people", "People")] },
  ];
}

export function workspaceNav(tenant: TenantId, active: WorkspacePage | null, billingOn: boolean): NavGroup {
  const items = [
    item("Overview", workspacePath(tenant), active === "overview"),
    item("Projects", workspacePath(tenant, "projects"), active === "projects"),
  ];
  if (billingOn) items.push(item("Billing", workspacePath(tenant, "billing"), active === "billing"));
  // Supabase connections, data retention, close workspace (decision 037).
  items.push(item("Settings", workspacePath(tenant, "settings"), active === "settings"));
  return { label: "Workspace", items };
}

// Owners and admins add projects; the picker refuses members anyway.
export const canAddProjects = (role: Role): boolean => role !== "member";

// The letter on the project tile: the first letter or digit of the name, upper case.
export function initialOf(name: string): string {
  const m = /[\p{L}\p{N}]/u.exec(name);
  return m ? m[0].toLocaleUpperCase("en-US") : "?";
}

export function utc(d: Date): string {
  return `${d.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}
