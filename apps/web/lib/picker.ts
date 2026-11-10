import type { Role } from "@supahound/core/db/user";
import { isPickable, ManagementApiError, PROJECT_REF, type SupabaseProject } from "@supahound/core/supabase/management";
import { OAuthError } from "@supahound/core/supabase/oauth";
import type { ConnectionId, TenantId } from "@supahound/core/tenancy/scope";

// The project picker (issue #9) as pure functions, so every branch is testable. The form is never
// trusted: the server lists the connection's projects again and inserts only refs Supabase
// returned, with Supabase's name. Owners and admins only, checked in each transaction.

export const MAX_PICK = 100;

export type PickerNotice =
  | "added" | "removed" | "none" | "role" | "connection" | "reconnect" | "supabase" | "mismatch" | "missing";

export const picksPath = (tenant: TenantId, notice: PickerNotice, n?: number) =>
  `/w/${tenant}/projects?${notice === "added" ? `added=${n ?? 0}` : notice === "removed" ? "removed=1" : `error=${notice}`}`;

export function submittedRefs(values: unknown[]): Set<string> {
  const refs = new Set<string>();
  for (const v of values) {
    if (typeof v === "string" && PROJECT_REF.test(v)) refs.add(v);
    if (refs.size >= MAX_PICK) break;
  }
  return refs;
}

export interface WatchDeps {
  // Inside withTenantForUser: the role, and the connection's token (null if the connection is not
  // in this tenant). Never fetches a token for a member. Throws OAuthError if a refresh fails.
  prepare: (connection: ConnectionId) => Promise<{ role: Role; token: string | null }>;
  list: (token: string) => Promise<SupabaseProject[]>;
  // Inside a second withTenantForUser: re-checks the role, then inserts. Null if no longer allowed.
  insert: (connection: ConnectionId, projects: { ref: string; name: string }[]) => Promise<string[] | null>;
}

export async function handleWatch(tenant: TenantId, connection: ConnectionId, values: unknown[], deps: WatchDeps): Promise<string> {
  const wanted = submittedRefs(values);
  if (wanted.size === 0) return picksPath(tenant, "none");
  let prepared: { role: Role; token: string | null };
  try {
    prepared = await deps.prepare(connection);
  } catch (err) {
    // A failed token refresh: the grant was revoked or expired. Nothing was written.
    if (err instanceof OAuthError) return picksPath(tenant, "reconnect");
    throw err;
  }
  const { role, token } = prepared;
  if (role === "member") return picksPath(tenant, "role");
  if (token === null) return picksPath(tenant, "connection");

  let available: SupabaseProject[];
  try {
    available = await deps.list(token);
  } catch (err) {
    if (err instanceof ManagementApiError && err.needsReconnect) return picksPath(tenant, "reconnect");
    return picksPath(tenant, "supabase");
  }
  const chosen = available.filter((p) => wanted.has(p.ref) && isPickable(p)).map((p) => ({ ref: p.ref, name: p.name }));
  if (chosen.length === 0) return picksPath(tenant, "none");

  const added = await deps.insert(connection, chosen);
  if (added === null) return picksPath(tenant, "role");
  return picksPath(tenant, "added", added.length);
}

// Remove needs the exact project name typed back (surrounding spaces ignored).
export function removalOutcome(role: Role, project: { name: string } | null, typed: string): "removed" | "role" | "missing" | "mismatch" {
  if (role === "member") return "role";
  if (!project) return "missing";
  if (typed.trim() !== project.name) return "mismatch";
  return "removed";
}
