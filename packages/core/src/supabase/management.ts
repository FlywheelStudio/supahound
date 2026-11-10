import { z } from "zod";
import { MANAGEMENT_API } from "../logs/client.js";

// Lists the Supabase projects an OAuth connection can see (the project picker, issue #9).
// Reference: https://supabase.com/docs/reference/api/v1-list-all-projects. Needs the OAuth
// scope `projects:read` on the Supabase OAuth app registration.

export const PROJECT_REF = /^[a-z0-9]{20}$/;

export class ManagementApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "ManagementApiError";
  }

  // 401 or 403: the grant was revoked or lacks a scope. The fix is to reconnect Supabase.
  get needsReconnect(): boolean {
    return this.status === 401 || this.status === 403;
  }
}

export interface SupabaseProject {
  ref: string;
  name: string;
  organizationId: string | null;
  region: string | null;
  status: string | null;
}

const row = z.object({
  ref: z.string().optional(),
  id: z.string().optional(),
  name: z.string().optional(),
  organization_id: z.string().nullish(),
  region: z.string().nullish(),
  status: z.string().nullish(),
});

// The API returns `ref` (the 20-character project ref) and, on older shapes, only `id`.
// A row without a valid ref or a usable name is dropped, never guessed.
export function parseProjects(body: unknown): SupabaseProject[] {
  if (!Array.isArray(body)) throw new ManagementApiError("Projects response is not an array", 200);
  const out = new Map<string, SupabaseProject>();
  for (const item of body) {
    const r = row.safeParse(item);
    if (!r.success) continue;
    const ref = [r.data.ref, r.data.id].find((v) => v !== undefined && PROJECT_REF.test(v));
    const name = r.data.name?.trim().slice(0, 200);
    if (!ref || !name) continue;
    out.set(ref, {
      ref, name,
      organizationId: r.data.organization_id ?? null,
      region: r.data.region ?? null,
      status: r.data.status ?? null,
    });
  }
  return [...out.values()].sort((a, b) => a.name.localeCompare(b.name) || a.ref.localeCompare(b.ref));
}

export async function listSupabaseProjects(
  token: string,
  options: { fetch?: typeof fetch; baseUrl?: string } = {},
): Promise<SupabaseProject[]> {
  const res = await (options.fetch ?? fetch)(new URL("/v1/projects", options.baseUrl ?? MANAGEMENT_API), {
    method: "GET",
    headers: { Authorization: `Bearer ${token}`, Accept: "application/json" },
    signal: AbortSignal.timeout(10_000),
  });
  if (!res.ok) throw new ManagementApiError(`Projects endpoint returned HTTP ${res.status}`, res.status);
  return parseProjects(await res.json());
}

// A project Supabase reports as running (ACTIVE_HEALTHY or ACTIVE_UNHEALTHY). Others (INACTIVE,
// COMING_UP, PAUSING, REMOVED ...) are shown but cannot be picked: every poll would fail.
// No status at all is allowed; the first poll then reports "unable to assess" if it is down.
export function isPickable(p: SupabaseProject): boolean {
  return p.status === null || p.status.startsWith("ACTIVE_");
}
