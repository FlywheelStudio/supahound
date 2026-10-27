import { createGateway, generateText, Output, type LanguageModel } from "ai";
import { z } from "zod";
import type { IncidentFeatures } from "./features.js";
import { templateExplanation } from "./template.js";
import { validateExplanation, type Explanation } from "./validate.js";

// THE ONLY MODULE THAT CALLS A MODEL. ESLint (no-restricted-imports) blocks model calls, the
// gateway and provider packages everywhere else, so every request goes through `callModel`,
// which always sends zero data retention (ZDR) to Vercel AI Gateway.
//
// ZDR rules (https://vercel.com/docs/ai-gateway/security-and-compliance/zdr):
//   * `providerOptions.gateway.zeroDataRetention: true` routes only to providers with a ZDR
//     agreement. If none serves the model, the gateway fails the request; it never falls back
//     to a retaining provider. The failure lands here as an error and the alert uses template
//     text.
//   * ZDR skips BYOK keys unless they are marked ZDR. This module uses gateway credentials only.
//   * No prompt caching, tools, files or images: plain structured text generation only.
//
// One call explains one incident of one tenant. Nothing here batches incidents.

// Primary: Haiku 5.5 ($0.10 / $0.50 per million tokens). Fallback, used only when Haiku refuses
// or fails: Grok 4.20 non-reasoning ($1.25 / $2.50), a different vendor so its safety
// classifiers are independent. Both list "Zero data retention: available" on the gateway's
// model page (checked 2026-10-27). Decision 011.
export const PRIMARY_MODEL = "anthropic/claude-haiku-5.5";
export const FALLBACK_MODEL = "spacexai/grok-4.20-non-reasoning";

interface ModelSettings {
  id: string;
  // Only for models that reason. Haiku 5.5 takes low effort; Grok non-reasoning takes none.
  reasoning?: "low";
}

const MODELS: readonly ModelSettings[] = [
  { id: PRIMARY_MODEL, reasoning: "low" },
  { id: FALLBACK_MODEL },
];

// Frozen, and applied last, so no caller and no future edit of a call site can drop ZDR.
const ZDR_PROVIDER_OPTIONS = Object.freeze({
  gateway: Object.freeze({ zeroDataRetention: true, disallowPromptTraining: true }),
});

const SYSTEM = `You explain one security incident in a Supabase app to its developer.
You receive structured facts as JSON. Use only those facts.
- Refer to the actor only as "actor A".
- Every number you write must appear in the facts. Write no other numbers.
- Put table, column and SDK names in backticks, exactly as given.
- No links, no markdown other than backticks, no HTML.
- summary: at most 3 plain sentences on what happened.
- likelyImpact: 1 or 2 sentences on what data or access is at risk.
- nextSteps: 1 to 5 short imperative steps the developer can take now.
Severity is already decided. Do not change it or argue with it.`;

const ExplanationSchema = z.object({
  summary: z.string().min(1).max(600),
  likelyImpact: z.string().min(1).max(400),
  nextSteps: z.array(z.string().min(1).max(200)).min(1).max(5),
});

export type ModelFactory = (modelId: string) => LanguageModel;

export interface ExplainerOptions {
  // Gateway credentials. Omit in tests that pass `models`.
  apiKey?: string;
  // Injected for tests only: lets a test capture the exact HTTP body sent to the gateway.
  fetch?: typeof fetch;
  baseURL?: string;
  // Injected for tests only: replaces the gateway with mock models.
  models?: ModelFactory;
  timeoutMs?: number;
}

export type AttemptOutcome = "ok" | "refused" | "error" | "invalid";

export interface ExplainResult {
  explanation: Explanation;
  source: "model" | "template";
  model: string | null;
  // True when the gateway's routing metadata says ZDR was applied; null when it said nothing.
  zdrConfirmed: boolean | null;
  attempts: { model: string; outcome: AttemptOutcome; detail?: string }[];
}

function modelFactory(options: ExplainerOptions): ModelFactory {
  if (options.models) return options.models;
  const gateway = createGateway({
    ...(options.apiKey !== undefined ? { apiKey: options.apiKey } : {}),
    ...(options.fetch ? { fetch: options.fetch } : {}),
    ...(options.baseURL ? { baseURL: options.baseURL } : {}),
  });
  return (id) => gateway(id);
}

function zdrConfirmed(providerMetadata: unknown): boolean | null {
  const routing = (providerMetadata as { gateway?: { routing?: { planningReasoning?: unknown } } } | undefined)
    ?.gateway?.routing;
  const reasoning = routing?.planningReasoning;
  if (typeof reasoning !== "string") return null;
  return /\bZDR\b/.test(reasoning);
}

interface ModelCall {
  outcome: AttemptOutcome;
  explanation?: Explanation;
  zdrConfirmed: boolean | null;
  detail?: string;
}

async function callModel(
  model: LanguageModel,
  settings: ModelSettings,
  features: IncidentFeatures,
  timeoutMs: number,
): Promise<ModelCall> {
  try {
    const result = await generateText({
      model,
      system: SYSTEM,
      prompt: JSON.stringify(features),
      output: Output.object({ schema: ExplanationSchema }),
      // No temperature: Haiku 5.5 rejects non-default sampling.
      ...(settings.reasoning ? { reasoning: settings.reasoning } : {}),
      // Thinking tokens count toward the cap, so leave headroom.
      maxOutputTokens: 4000,
      maxRetries: 1,
      abortSignal: AbortSignal.timeout(timeoutMs),
      providerOptions: ZDR_PROVIDER_OPTIONS,
    });
    const confirmed = zdrConfirmed(result.providerMetadata);
    // Haiku 5.5 safety classifiers can decline benign security text; the SDK reports that as
    // a content-filter finish, not an error. There is no server-side fallback, so go to the
    // next model.
    if (result.finishReason === "content-filter") return { outcome: "refused", zdrConfirmed: confirmed };
    return { outcome: "ok", explanation: result.output, zdrConfirmed: confirmed };
  } catch (err) {
    const name = err instanceof Error ? err.name : "unknown";
    return { outcome: "error", zdrConfirmed: null, detail: name };
  }
}

export async function explainIncident(features: IncidentFeatures, options: ExplainerOptions = {}): Promise<ExplainResult> {
  const factory = modelFactory(options);
  const attempts: ExplainResult["attempts"] = [];

  for (const settings of MODELS) {
    const id = settings.id;
    const call = await callModel(factory(id), settings, features, options.timeoutMs ?? 20_000);
    if (call.outcome !== "ok" || !call.explanation) {
      attempts.push({ model: id, outcome: call.outcome, ...(call.detail ? { detail: call.detail } : {}) });
      continue;
    }
    // A routing report that names providers without ZDR is a hard stop: discard the output.
    if (call.zdrConfirmed === false) {
      attempts.push({ model: id, outcome: "error", detail: "zdr_not_confirmed" });
      continue;
    }
    const problems = validateExplanation(call.explanation, features);
    if (problems.length > 0) {
      // PRD: on a mismatch the alert falls back to template text. Do not try another model.
      attempts.push({ model: id, outcome: "invalid", detail: problems.slice(0, 5).join(",") });
      break;
    }
    attempts.push({ model: id, outcome: "ok" });
    return { explanation: call.explanation, source: "model", model: id, zdrConfirmed: call.zdrConfirmed, attempts };
  }

  return { explanation: templateExplanation(features), source: "template", model: null, zdrConfirmed: null, attempts };
}
