import { isAlertLevel, type AlertLevel } from "@supahound/core/alerts/email";
import type { ProjectId, TenantId } from "@supahound/core/tenancy/scope";
import { projectPath, workspacePath } from "./nav";

// The per-project email alert threshold (issue #16, decision 030) as pure functions, so every
// branch is testable. The project's owners, admins and editors change it (decision 036); the role
// is checked in the same transaction as the write.

export const ALERT_LEVEL_LABEL: Record<AlertLevel, string> = {
  low: "Every incident",
  medium: "Medium and above",
  high: "High and above",
  critical: "Critical only",
  off: "Off",
};

export type AlertNotice = "saved" | "role" | "level" | "missing";

// Saved and refused go back to the project's Notifications page (issue #98). A project that is not
// in the workspace has no such page, so that notice shows on the workspace's project list.
export function alertsPath(tenant: TenantId, project: ProjectId, notice: AlertNotice, level?: AlertLevel): string {
  if (notice === "missing") return `${workspacePath(tenant, "projects")}?error=alerts_missing`;
  return `${projectPath(tenant, project, "notifications")}?${notice === "saved" ? `alerts=${level}` : `error=alerts_${notice}`}`;
}

export interface AlertSettingDeps {
  // Inside the project transaction: whether the user's project role may change settings and, only
  // then, whether the project row was updated. Must not write when not allowed.
  apply: (level: AlertLevel) => Promise<{ allowed: boolean; updated: boolean }>;
}

export async function handleAlertSetting(tenant: TenantId, project: ProjectId, value: unknown, deps: AlertSettingDeps): Promise<string> {
  if (!isAlertLevel(value)) return alertsPath(tenant, project, "level");
  const { allowed, updated } = await deps.apply(value);
  if (!allowed) return alertsPath(tenant, project, "role");
  if (!updated) return alertsPath(tenant, project, "missing");
  return alertsPath(tenant, project, "saved", value);
}
