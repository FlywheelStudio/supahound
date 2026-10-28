import { buildFeatures } from "@supahound/core/explainer/features";
import { explainIncident, FALLBACK_MODEL, PRIMARY_MODEL } from "@supahound/core/explainer/llm";
import { normalizeRow } from "@supahound/core/logs/event";
import { ownershipFromColumns } from "@supahound/core/ownership/ownership";
import { ServiceRoleNetworks } from "@supahound/core/detectors/serviceRole";
import { scan } from "@supahound/core/scan";
import { connectionId, projectScope, tenantId } from "@supahound/core/tenancy/scope";
import { TokenVault, VaultError } from "@supahound/core/vault/vault";
import { MockLanguageModelV4 } from "ai/test";
import { env } from "cloudflare:workers";
import { describe, expect, it } from "vitest";
import { enqueueDue, handleMessages, parseMessage, type QueueMessageLike } from "../src/index.js";

const SCOPE = projectScope("aaaaaaaa-0000-4000-8000-000000000001", "11111111-0000-4000-8000-0000000000aa");
const ALICE = "11111111-1111-4111-8111-111111111111";
const BOB = "22222222-2222-4222-8222-222222222222";

describe("core inside workerd", () => {
  it("seals and opens tokens with node:crypto, and refuses another tenant", () => {
    const vault = TokenVault.fromEnv({ SUPAHOUND_MASTER_KEYS: env.SUPAHOUND_MASTER_KEYS });
    const binding = { tenantId: SCOPE.tenantId, connectionId: connectionId("c0000000-0000-4000-8000-000000000001") };
    const sealed = vault.seal("token", binding);
    expect(vault.open(sealed, binding)).toBe("token");
    expect(() => vault.open(sealed, { ...binding, tenantId: tenantId("bbbbbbbb-0000-4000-8000-000000000002") })).toThrow(VaultError);
  });

  it("runs the detectors", () => {
    const event = normalizeRow({
      method: "GET", path: "/rest/v1/notes", search: `?user_id=eq.${BOB}`, status: "200", contentRange: "0-9/*",
      jwtSubject: ALICE, jwtRole: "authenticated", hits: "3", first_seen: "2026-10-27T12:00:00Z", last_seen: "2026-10-27T12:01:00Z",
    });
    const findings = scan([event], { scope: SCOPE, networks: new ServiceRoleNetworks(), ownership: ownershipFromColumns({ notes: ["user_id"] }) });
    expect(findings.map((f) => [f.detector, f.severity])).toEqual([["cross_tenant", "critical"]]);
  });

  it("calls the AI SDK with ZDR on both models", async () => {
    const features = buildFeatures(
      { id: null, scope: SCOPE, actor: `user:${ALICE}`, status: "open", severity: "critical", detectors: ["cross_tenant"],
        signals: ["other_owner"], findingCount: 1, hits: 3, openedAt: new Date(), lastSeenAt: new Date() },
      [],
    );
    const calls: Record<string, MockLanguageModelV4> = {};
    const r = await explainIncident(features, {
      models: (id) => (calls[id] = new MockLanguageModelV4({
        doGenerate: async () => ({
          content: [], finishReason: { unified: "content-filter", raw: "refusal" }, warnings: [],
          usage: { inputTokens: { total: 1, noCache: 1, cacheRead: 0, cacheWrite: 0 }, outputTokens: { total: 0, text: 0, reasoning: 0 } },
        }),
      })),
    });
    expect(r.source).toBe("template");
    for (const id of [PRIMARY_MODEL, FALLBACK_MODEL]) {
      expect(calls[id]!.doGenerateCalls[0]!.providerOptions?.gateway).toMatchObject({ zeroDataRetention: true });
    }
  });
});

describe("queue handlers", () => {
  it("accepts only well-formed scopes", () => {
    expect(parseMessage({ tenantId: SCOPE.tenantId, projectId: SCOPE.projectId })).toEqual(SCOPE);
    for (const bad of [null, "x", {}, { tenantId: "t", projectId: "p" }, { tenantId: SCOPE.tenantId }]) {
      expect(parseMessage(bad)).toBeNull();
    }
  });

  it("acks polls and malformed messages, and retries crashes", async () => {
    const seen: string[] = [];
    const msg = (body: unknown): QueueMessageLike & { state: string } => {
      const m = { body, state: "pending", ack() { m.state = "ack"; }, retry() { m.state = "retry"; } };
      return m;
    };
    const good = msg({ tenantId: SCOPE.tenantId, projectId: SCOPE.projectId });
    const bad = msg({ nope: true });
    const crash = msg({ tenantId: "bbbbbbbb-0000-4000-8000-000000000002", projectId: SCOPE.projectId });
    await handleMessages([good, bad, crash], async (scope) => {
      seen.push(scope.tenantId);
      if (scope.tenantId.startsWith("bbbb")) throw new Error("boom");
      return { status: "ok", findings: 0, notified: 0 };
    });
    expect([good.state, bad.state, crash.state]).toEqual(["ack", "ack", "retry"]);
    expect(seen).toEqual([SCOPE.tenantId, "bbbbbbbb-0000-4000-8000-000000000002"]);
  });

  it("enqueues in batches of at most 100", async () => {
    const batches: number[] = [];
    const scopes = Array.from({ length: 250 }, () => SCOPE);
    expect(await enqueueDue(scopes, { sendBatch: async (b) => { batches.push([...b].length); } })).toBe(250);
    expect(batches).toEqual([100, 100, 50]);
  });
});
