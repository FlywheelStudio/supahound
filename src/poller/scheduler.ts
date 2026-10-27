import type { Pool } from "pg";
import { dueProjects } from "../db/repo.js";
import { scopeKey, type ProjectScope } from "../tenancy/scope.js";
import { pollProject, type PollDeps, type PollOutcome } from "./pollProject.js";

// Picks due projects (IDs only, through the scheduler role) and polls them with bounded
// concurrency. Jobs share nothing but the connection pool: each opens its own tenant
// transactions, and one project's failure never stops or touches another's.

export interface SchedulerDeps extends PollDeps {
  scheduler: Pool;
  concurrency?: number;
  batchSize?: number;
}

export interface JobResult {
  scope: ProjectScope;
  outcome: PollOutcome | { status: "crashed" };
}

export async function runDuePolls(deps: SchedulerDeps): Promise<JobResult[]> {
  const scopes = await dueProjects(deps.scheduler, deps.intervalSeconds ?? 60, deps.batchSize ?? 200);
  const queue = [...new Map(scopes.map((s) => [scopeKey(s), s])).values()];
  const results: JobResult[] = [];

  const worker = async () => {
    for (let scope = queue.shift(); scope; scope = queue.shift()) {
      try {
        results.push({ scope, outcome: await pollProject(scope, deps) });
      } catch {
        // Logged by scope only: never the error text, which can carry customer data.
        results.push({ scope, outcome: { status: "crashed" } });
      }
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, deps.concurrency ?? 8) }, worker));
  return results;
}
