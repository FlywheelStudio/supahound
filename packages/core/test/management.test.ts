import { describe, expect, it } from "vitest";
import { isPickable, listSupabaseProjects, ManagementApiError, parseProjects } from "../src/supabase/management.js";

const REF_A = "abcdefghijklmnopqrst";
const REF_B = "bbbbbbbbbbbbbbbbbbbb";

function capture(status: number, body: unknown) {
  const calls: { url: string; init: RequestInit }[] = [];
  const f = (async (url: Parameters<typeof fetch>[0], init?: RequestInit) => {
    calls.push({ url: String(url), init: init ?? {} });
    return new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  }) as typeof fetch;
  return { f, calls };
}

describe("Management API: list projects", () => {
  it("calls GET /v1/projects with the bearer token on the given base URL", async () => {
    const { f, calls } = capture(200, [{ ref: REF_A, id: "x", name: "Shop", organization_id: "org", region: "us-east-1", status: "ACTIVE_HEALTHY" }]);
    const projects = await listSupabaseProjects("tok", { fetch: f, baseUrl: "http://fake.test" });
    expect(calls[0]!.url).toBe("http://fake.test/v1/projects");
    expect(calls[0]!.init.method).toBe("GET");
    expect((calls[0]!.init.headers as Record<string, string>).Authorization).toBe("Bearer tok");
    expect(projects).toEqual([{ ref: REF_A, name: "Shop", organizationId: "org", region: "us-east-1", status: "ACTIVE_HEALTHY" }]);
  });

  it("defaults to api.supabase.com", async () => {
    const { f, calls } = capture(200, []);
    await listSupabaseProjects("tok", { fetch: f });
    expect(calls[0]!.url).toBe("https://api.supabase.com/v1/projects");
  });

  it.each([401, 403])("marks HTTP %i as needing a reconnect", async (status) => {
    const { f } = capture(status, { message: "nope" });
    const err = await listSupabaseProjects("tok", { fetch: f }).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(ManagementApiError);
    expect((err as ManagementApiError).needsReconnect).toBe(true);
  });

  it("does not ask for a reconnect on a server error", async () => {
    const { f } = capture(500, {});
    const err = (await listSupabaseProjects("tok", { fetch: f }).catch((e: unknown) => e)) as ManagementApiError;
    expect(err.status).toBe(500);
    expect(err.needsReconnect).toBe(false);
  });

  it("rejects a body that is not an array", () => {
    expect(() => parseProjects({ projects: [] })).toThrow(ManagementApiError);
  });
});

describe("parseProjects", () => {
  it("takes the ref from `ref`, else from `id`", () => {
    const out = parseProjects([{ id: REF_B, name: "Old shape" }, { ref: REF_A, id: "123", name: "New shape" }]);
    expect(out.map((p) => p.ref)).toEqual([REF_A, REF_B]);
  });

  it("drops rows without a valid ref or a name, and never guesses", () => {
    const out = parseProjects([
      { ref: "SHORT", name: "bad ref" },
      { ref: "ABCDEFGHIJKLMNOPQRST", name: "upper case" },
      { ref: `${REF_A}; drop`, name: "injection" },
      { ref: REF_A, name: "   " },
      { ref: REF_B },
      "not an object",
      null,
      { ref: REF_A, name: 42 },
    ]);
    expect(out).toEqual([]);
  });

  it("removes duplicates, trims and caps names, sorts by name", () => {
    const out = parseProjects([
      { ref: REF_B, name: "  zeta  " },
      { ref: REF_A, name: "x".repeat(300) },
      { ref: REF_B, name: "zeta" },
    ]);
    expect(out.map((p) => [p.ref, p.name.length])).toEqual([[REF_A, 200], [REF_B, 4]]);
  });
});

describe("isPickable", () => {
  const p = (status: string | null) => ({ ref: REF_A, name: "n", organizationId: null, region: null, status });
  it.each([["ACTIVE_HEALTHY", true], ["ACTIVE_UNHEALTHY", true], [null, true], ["INACTIVE", false], ["COMING_UP", false], ["PAUSING", false], ["REMOVED", false]] as const)(
    "%s → %s", (status, expected) => expect(isPickable(p(status))).toBe(expected),
  );
});
