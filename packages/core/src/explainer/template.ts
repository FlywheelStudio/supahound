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

  if (f.rpcExposure && !f.rpcExposure.roles.includes("anon")) {
    // Signed-in calls only (issue #157): low, a record of use rather than an attack.
    const r = f.rpcExposure;
    parts.push(
      `Signed-in users called ${list(r.functions)}, which the posture scan shows runs as SECURITY DEFINER and every signed-in user may execute.`,
    );
    impact = "The function runs with its owner's rights and skips row-level security, so it must check the caller itself. Calls from your own app are expected.";
    steps.push(`Check that ${list(r.functions)} checks \`auth.uid()\` and its arguments before it reads or changes data.`);
    steps.push("If signed-in users do not need it, revoke EXECUTE from `authenticated`. The project's Posture page has the details.");
  } else if (f.rpcExposure) {
    const r = f.rpcExposure;
    parts.push(
      `Signed-out callers using the \`anon\` key called ${list(r.functions)}, which the posture scan shows runs as SECURITY DEFINER and anyone with that key may execute.`,
    );
    impact = "A SECURITY DEFINER function runs with its owner's rights and skips row-level security, so whatever it reads or changes is open to anyone with the `anon` key.";
    steps.unshift(`Revoke EXECUTE on ${list(r.functions)} from \`anon\`, or make it SECURITY INVOKER. The project's Posture page has the details.`);
    steps.push("Check that the function validates its arguments and the caller before it reads or changes data.");
  }
  if (f.exposedRead) {
    const r = f.exposedRead;
    parts.push(
      `Signed-out callers using the \`anon\` key read ${list(r.tables)}, which the posture scan shows readable by anyone with that key.`,
    );
    if (r.rowsReturned !== null && r.rowsReturned > 0) {
      impact = `The \`anon\` key received ${r.rowsReturned} row(s), so this data is public to anyone who has the key, and the key ships in every client app.`;
    } else {
      impact = "No rows came back in these responses, so this looks like a probe of an exposed table.";
    }
    steps.unshift(`Fix the posture finding on ${list(r.tables)}: enable RLS or narrow the policy. The project's Posture page has the SQL.`);
    steps.push("If this table should be public, make that explicit with a read-only policy and confirm it holds nothing private.");
  }

  if (f.storageListing) {
    const s = f.storageListing;
    const named = s.buckets.length > 0 ? list(s.buckets) : null;
    const others = s.unnamedBuckets > 0 ? `${s.unnamedBuckets} bucket(s) posture does not flag` : null;
    parts.push(`Signed-out callers using the \`anon\` key listed the files of ${[named, others].filter(Boolean).join(" and ")} in Storage.`);
    if (named) {
      impact = `The posture scan shows anyone may list ${named}, and its files are public, so every file name it holds can be found and downloaded.`;
      steps.unshift(`Drop the listing policy on ${named}: public file URLs keep working without it. The project's Posture page has the SQL.`);
    } else {
      impact = "Storage does not log whether a listing returned files. Row-level security on Storage decides what the `anon` key may list.";
    }
    steps.push("Check the SELECT policies on Storage objects that apply to the `anon` key.");
  }

  parts.push(`Supahound saw ${f.hits} request(s) over ${f.durationMinutes} minute(s).`);
  return { summary: parts.join(" "), likelyImpact: impact, nextSteps: steps.slice(0, 5) };
}
