import type { EdgeEvent } from "./logs/event.js";
import type { OwnershipMap } from "./ownership/ownership.js";
import { detectCrossTenant } from "./detectors/crossTenant.js";
import { detectServiceRoleMisuse, type ServiceRoleContext } from "./detectors/serviceRole.js";
import { SEVERITY_RANK, type Finding } from "./detectors/finding.js";

export interface ScanContext extends ServiceRoleContext {
  ownership: OwnershipMap;
}

// Runs both baseline-free detectors over one poll. Scoring, deduplication across polls and
// alerting belong to the incident engine, which this prototype does not include.
export function scan(events: EdgeEvent[], ctx: ScanContext): Finding[] {
  const findings: Finding[] = [];
  for (const event of events) {
    const f = detectCrossTenant(event, ctx.ownership);
    if (f) findings.push(f);
  }
  findings.push(...detectServiceRoleMisuse(events, ctx));
  return findings.sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.hits - a.hits,
  );
}
