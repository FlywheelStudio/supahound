import type { Severity } from "../detectors/finding.js";

// Posture scan (issue #11, decision 038): what one finding holds. Structured fields only:
// enums, booleans, counts and catalog identifiers. No Supabase free text (Advisor titles,
// descriptions, details), no log text and no model output.

export type PostureSource = "catalog" | "advisor";

// The catalog checks Supahound runs itself. Advisor findings use the lint name as their check.
export type CatalogCheck = "rls_disabled" | "rls_no_policies" | "permissive_policy" | "view_not_invoker";
export const CATALOG_CHECKS: readonly CatalogCheck[] = ["rls_disabled", "rls_no_policies", "permissive_policy", "view_not_invoker"];

// Who can reach the object through the Data API: anon (signed out), authenticated only, or neither.
export type Exposure = "anon" | "authenticated" | "none";

export type PostureEvidenceValue = string | number | boolean | null | string[];

export interface PostureFinding {
  source: PostureSource;
  check: string;
  severity: Severity;
  schema: string | null;
  object: string | null;
  // table, view, function, ... (catalog: table or view; Advisor: metadata.type).
  objectType: string | null;
  evidence: Record<string, PostureEvidenceValue>;
}

export type SourceStatus = "ok" | "unauthorized" | "rate_limited" | "query_failed" | "invalid_response" | "network_error" | "unavailable";
