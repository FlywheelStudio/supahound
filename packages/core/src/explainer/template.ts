import type { IncidentFeatures } from "./features.js";
import type { Explanation } from "./validate.js";

// Last resort when no model is available, refuses, or fails validation (PRD, AI models).
// Built only from structured features, so it is always safe to send.

const list = (xs: string[]) => xs.map((x) => `\`${x}\``).join(", ");

export function templateExplanation(f: IncidentFeatures): Explanation {
  const parts: string[] = [];
  const steps: string[] = [];
  let impact = "No data access is confirmed yet.";

  if (f.crossTenant) {
    const c = f.crossTenant;
    parts.push(
      `A signed-in user requested rows owned by ${c.foreignIdCount} other user(s) in ${list(c.tables)}, filtering on ${list(c.columns)}.`,
    );
    if (c.outcomes.includes("rows_returned")) {
      impact = `Row-level security returned up to ${c.maxRowsReturned ?? 0} rows, so other users' data may be exposed.`;
      steps.push(`Check the RLS policy on ${list(c.tables)} compares ${list(c.columns)} to \`auth.uid()\`.`);
    } else {
      impact = "Row-level security returned no rows, so this looks like a blocked probe.";
    }
    if (f.signals.includes("posture_exposed")) {
      steps.unshift(`Fix the posture finding on ${list(c.tables)} first: the project's Posture page has the SQL.`);
    }
    steps.push("Review this user's other requests in the incident timeline.");
  }

  if (f.serviceRole) {
    const s = f.serviceRole;
    parts.push(
      `The service-role key was used from ${s.callerClasses.join(", ")} callers on ${s.networkTypes.join(", ")} networks.`,
    );
    if (s.callerClasses.includes("browser") || s.callerClasses.includes("mobile_app")) {
      impact = "The service-role key bypasses row-level security, and a client app holding it can read and change every table.";
    }
    steps.unshift("Rotate the service-role key in the Supabase dashboard, then update your servers.");
    steps.push("Remove the service-role key from any client-side code.");
  }

  if (f.rpcExposure) {
    const r = f.rpcExposure;
    parts.push(
      `Signed-out callers using the \`anon\` key called ${list(r.functions)}, which the posture scan shows runs as SECURITY DEFINER and anyone with that key may execute.`,
    );
    impact = "A SECURITY DEFINER function runs with its owner's rights and skips row-level security, so whatever it reads or changes is open to anyone with the `anon` key.";
    steps.unshift(`Revoke EXECUTE on ${list(r.functions)} from \`anon\`, or make it SECURITY INVOKER. The project's Posture page has the details.`);
    steps.push("Check that the function validates its arguments and the caller before it reads or changes data.");
  }

  parts.push(`Supahound saw ${f.hits} request(s) over ${f.durationMinutes} minute(s).`);
  return { summary: parts.join(" "), likelyImpact: impact, nextSteps: steps.slice(0, 5) };
}
