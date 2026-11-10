import type { ProjectSummary } from "@supahound/core/db/repo";

// Detector 2 (cross-tenant reads) coverage for one project (decision 024). A project it cannot
// assess must never read as clean, so both gaps get a line of their own on the overview.
export function crossTenantNote(coverage: ProjectSummary["crossTenant"]): { tone: "warn" | "info"; text: string } | null {
  switch (coverage) {
    case "unable_to_assess":
      return {
        tone: "warn",
        text: "Cross-tenant reads: unable to assess. Supahound could not read this project's RLS policies; it retries every hour.",
      };
    case "no_owned_tables":
      return {
        tone: "info",
        text: "Cross-tenant reads: no owner-scoped tables found. No RLS policy limits a table's rows to their owner, so there is nothing to check.",
      };
    default:
      return null;
  }
}
