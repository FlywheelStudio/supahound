// Read-only client for the Supabase Management API logs endpoint.
// Reference: https://supabase.com/docs/reference/api/v1-get-project-logs (analytics:read).

export const MANAGEMENT_API = "https://api.supabase.com";
export const MAX_WINDOW_MS = 24 * 60 * 60 * 1000;

export class LogsApiError extends Error {
  constructor(
    message: string,
    readonly status: number,
  ) {
    super(message);
    this.name = "LogsApiError";
  }
}

export interface LogsQuery {
  projectRef: string;
  sql: string;
  start: Date;
  end: Date;
}

export interface LogsClientOptions {
  token: string;
  fetch?: typeof fetch;
  baseUrl?: string;
}

export function buildLogsUrl(query: LogsQuery, baseUrl = MANAGEMENT_API): URL {
  if (!/^[a-z0-9]{20}$/.test(query.projectRef)) {
    throw new Error(`Not a Supabase project ref: "${query.projectRef}"`);
  }
  const span = query.end.getTime() - query.start.getTime();
  if (span <= 0) throw new Error("Window end must be after its start");
  if (span > MAX_WINDOW_MS) throw new Error("Supabase caps a logs query at 24 hours");
  const url = new URL(`/v1/projects/${query.projectRef}/analytics/endpoints/logs`, baseUrl);
  url.searchParams.set("sql", query.sql);
  url.searchParams.set("iso_timestamp_start", query.start.toISOString());
  url.searchParams.set("iso_timestamp_end", query.end.toISOString());
  return url;
}

function errorText(error: unknown): string | null {
  if (error === null || error === undefined || error === "") return null;
  if (typeof error === "string") return error;
  if (typeof error === "object" && "message" in error && typeof error.message === "string") {
    return error.message;
  }
  return JSON.stringify(error);
}

// The endpoint reports query errors in an HTTP 200 body, so every 200 is checked for `error`.
export async function queryLogs(
  query: LogsQuery,
  options: LogsClientOptions,
): Promise<Record<string, unknown>[]> {
  const doFetch = options.fetch ?? fetch;
  const res = await doFetch(buildLogsUrl(query, options.baseUrl), {
    method: "GET",
    headers: { Authorization: `Bearer ${options.token}`, Accept: "application/json" },
  });
  if (!res.ok) {
    throw new LogsApiError(`Logs endpoint returned HTTP ${res.status}`, res.status);
  }
  const body = (await res.json()) as { result?: unknown; error?: unknown };
  const error = errorText(body.error);
  if (error !== null) throw new LogsApiError(`Logs query failed: ${error}`, res.status);
  if (!Array.isArray(body.result)) throw new LogsApiError("Logs response has no result array", res.status);
  return body.result.filter((r): r is Record<string, unknown> => r !== null && typeof r === "object");
}

// Logs land late, so each poll ends `lagSeconds` before now.
export function pollWindow(now: Date, minutes: number, lagSeconds = 90): { start: Date; end: Date } {
  const end = new Date(now.getTime() - lagSeconds * 1000);
  return { start: new Date(end.getTime() - minutes * 60 * 1000), end };
}
