import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Zero data retention guard. packages/core/src/explainer/llm.ts is the only file allowed to call a model; it
// forces providerOptions.gateway.zeroDataRetention on every request. Everything else is blocked
// from the call functions, the gateway factory, provider SDKs (which skip the gateway), dynamic
// imports of them, and hard-coded vendor endpoints.
const ZDR_MESSAGE = "Model calls must go through packages/core/src/explainer/llm.ts, which forces zero data retention.";
export const MODEL_CALL_FILE = "packages/core/src/explainer/llm.ts";

const ZDR_PATHS = [{
  name: "ai",
  importNames: [
    "generateText", "streamText", "generateObject", "streamObject", "embed", "embedMany",
    "createGateway", "gateway", "createProviderRegistry", "customProvider", "wrapLanguageModel",
    "Agent", "ToolLoopAgent", "generateImage", "experimental_generateImage", "transcribe",
    "experimental_transcribe", "generateSpeech", "experimental_generateSpeech", "rerank",
  ],
  message: ZDR_MESSAGE,
}];
const ZDR_PATTERNS = [{ group: ["@ai-sdk/*", "@anthropic-ai/*", "openai", "@openai/*"], message: ZDR_MESSAGE }];

const zdrGuard = {
  files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
  ignores: [MODEL_CALL_FILE],
  rules: {
    "no-restricted-imports": ["error", { paths: ZDR_PATHS, patterns: ZDR_PATTERNS }],
    "no-restricted-syntax": ["error",
      { selector: "ImportExpression[source.value=/^(ai|@ai-sdk\\/.*|@anthropic-ai\\/.*|openai)$/]", message: ZDR_MESSAGE },
      { selector: "Literal[value=/ai-gateway\\.vercel\\.sh|api\\.anthropic\\.com|api\\.openai\\.com/]", message: ZDR_MESSAGE },
      { selector: "TemplateElement[value.raw=/ai-gateway\\.vercel\\.sh|api\\.anthropic\\.com|api\\.openai\\.com/]", message: ZDR_MESSAGE },
    ],
  },
};

// The web app runs no AI at all (Erik, 2026-11-10): no "ai" package, not even types, and not the
// explainer. Models run only in the poller, through llm.ts.
const NO_AI_MESSAGE = "The web app runs no AI. Model calls happen only in the poller, through packages/core/src/explainer/llm.ts.";
const WEB_NO_AI_PATHS = [{ name: "ai", message: NO_AI_MESSAGE }];
const WEB_NO_AI_PATTERNS = [{ group: ["@supahound/core/explainer/llm", "@supahound/core/explainer/llm.*"], message: NO_AI_MESSAGE }];

// The billing gate (decision 028): signed-in tenant pages and actions use withPaidTenantForUser.
// Only the billing routes, which a workspace needs before it pays, may use withTenantForUser.
const GATE_MESSAGE = "Use withPaidTenantForUser (packages/core/src/db/billing.ts): every tenant page and action needs a validated card. Only the billing routes may use withTenantForUser.";
const GATE_PATHS = [{ name: "@supahound/core/db/user", importNames: ["withTenantForUser"], message: GATE_MESSAGE }];
export const BILLING_ROUTE_FILES = ["apps/web/app/w/[[]tenantId]/billing/**"];

// One block per file set, because a later no-restricted-imports entry replaces an earlier one.
const webGuard = {
  files: ["apps/web/**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
  ignores: BILLING_ROUTE_FILES,
  rules: {
    "no-restricted-imports": ["error", {
      paths: [...ZDR_PATHS, ...WEB_NO_AI_PATHS, ...GATE_PATHS],
      patterns: [...ZDR_PATTERNS, ...WEB_NO_AI_PATTERNS],
    }],
  },
};
const webBillingGuard = {
  files: BILLING_ROUTE_FILES,
  rules: {
    "no-restricted-imports": ["error", {
      paths: [...ZDR_PATHS, ...WEB_NO_AI_PATHS],
      patterns: [...ZDR_PATTERNS, ...WEB_NO_AI_PATTERNS],
    }],
  },
};

export default tseslint.config(
  { ignores: ["**/dist", "**/node_modules", "**/.wrangler", "**/.vinext", "**/.next", "**/worker-configuration.d.ts", "**/playwright-report", "**/test-results"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  zdrGuard,
  webGuard,
  webBillingGuard,
);
