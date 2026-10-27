import type { EdgeEvent } from "../src/logs/event.js";

// Synthetic IDs only. Real log rows never go in fixtures.
export const ALICE = "11111111-1111-4111-8111-111111111111";
export const BOB = "22222222-2222-4222-8222-222222222222";
export const CAROL = "33333333-3333-4333-8333-333333333333";

export const CHROME_UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/141.0.0.0 Safari/537.36";

export function event(overrides: Partial<EdgeEvent> = {}): EdgeEvent {
  return {
    firstSeen: "2026-10-27T12:00:00Z",
    lastSeen: "2026-10-27T12:00:00Z",
    hits: 1,
    method: "GET",
    path: "/rest/v1/notes",
    search: "",
    status: 200,
    contentRange: "0-0/*",
    userAgent: CHROME_UA,
    clientInfo: "supabase-js-web/2.80.0",
    asn: 7922,
    asOrganization: "Comcast Cable Communications, LLC",
    jwtSubject: ALICE,
    jwtRole: "authenticated",
    apiKeyRole: "anon",
    ...overrides,
  };
}

export function serviceEvent(overrides: Partial<EdgeEvent> = {}): EdgeEvent {
  return event({
    jwtSubject: null,
    jwtRole: "service_role",
    apiKeyRole: "service_role",
    userAgent: "node",
    clientInfo: "supabase-js-node/2.80.0",
    asn: 16509,
    asOrganization: "Amazon.com, Inc.",
    ...overrides,
  });
}
