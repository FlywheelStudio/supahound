import type { EdgeEvent } from "./logs/event.js";
import type { OwnershipMap } from "./ownership/ownership.js";
import { detectCrossTenant } from "./detectors/crossTenant.js";
import { detectServiceRoleMisuse, type ServiceRoleContext } from "./detectors/serviceRole.js";
import { detectExposedReads } from "./detectors/exposedRead.js";
import { detectRpcExposure } from "./detectors/rpcExposure.js";
import { SEVERITY_RANK, type Finding } from "./detectors/finding.js";
import type { AnonReadable, DefinerExposure } from "./posture/findings.js";

export interface ScanContext extends ServiceRoleContext {
  ownership: OwnershipMap;
  // Tables posture shows readable by anon (issue #132). Absent or empty: no anon-read findings.
  anonReadable?: ReadonlyMap<string, AnonReadable>;
  // SECURITY DEFINER functions posture shows anon-executable (issue #131). Absent or empty: no
  // RPC findings.
  anonDefiners?: ReadonlyMap<string, DefinerExposure>;
}

// Runs the baseline-free detectors over one poll. Scoring, deduplication across polls and
// alerting belong to the incident engine.
export function scan(events: EdgeEvent[], ctx: ScanContext): Finding[] {
  const findings: Finding[] = [];
  for (const event of events) {
    const f = detectCrossTenant(event, ctx.ownership);
    if (f) findings.push(f);
  }
  findings.push(...detectServiceRoleMisuse(events, ctx));
  findings.push(...detectRpcExposure(events, ctx.anonDefiners ?? new Map()));
  findings.push(...detectExposedReads(events, ctx.anonReadable ?? new Map()));
  return findings.sort(
    (a, b) => SEVERITY_RANK[b.severity] - SEVERITY_RANK[a.severity] || b.hits - a.hits,
  );
}
