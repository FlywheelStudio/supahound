// Tenant and project identity. Every piece of state Guardbase keeps is keyed by a ProjectScope,
// never by a Supabase project ref: the same ref can belong to two tenants (an agency and its
// client), and their data must never meet.

declare const brand: unique symbol;
type Brand<T, B extends string> = T & { readonly [brand]: B };

export type TenantId = Brand<string, "TenantId">;
export type ConnectionId = Brand<string, "ConnectionId">;
export type ProjectId = Brand<string, "ProjectId">;

export interface ProjectScope {
  readonly tenantId: TenantId;
  readonly projectId: ProjectId;
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/;

function uuid<B extends string>(value: string, label: B): Brand<string, B> {
  const v = value.toLowerCase();
  if (!UUID.test(v)) throw new Error(`${label} must be a UUID`);
  return v as Brand<string, B>;
}

export const tenantId = (v: string): TenantId => uuid(v, "TenantId");
export const connectionId = (v: string): ConnectionId => uuid(v, "ConnectionId");
export const projectId = (v: string): ProjectId => uuid(v, "ProjectId");

export function projectScope(tenant: string, project: string): ProjectScope {
  return Object.freeze({ tenantId: tenantId(tenant), projectId: projectId(project) });
}

// Stable key for maps and caches. Includes the tenant so a bug that reuses a project ID across
// tenants still cannot collide.
export function scopeKey(scope: ProjectScope): string {
  return `${scope.tenantId}/${scope.projectId}`;
}
