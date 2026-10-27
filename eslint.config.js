import js from "@eslint/js";
import tseslint from "typescript-eslint";

// Zero data retention guard. src/explainer/llm.ts is the only file allowed to call a model; it
// forces providerOptions.gateway.zeroDataRetention on every request. Everything else is blocked
// from the call functions, the gateway factory, provider SDKs (which skip the gateway), dynamic
// imports of them, and hard-coded vendor endpoints.
const ZDR_MESSAGE = "Model calls must go through src/explainer/llm.ts, which forces zero data retention.";
export const MODEL_CALL_FILE = "src/explainer/llm.ts";

const zdrGuard = {
  files: ["**/*.{ts,tsx,mts,cts,js,mjs,cjs}"],
  ignores: [MODEL_CALL_FILE],
  rules: {
    "no-restricted-imports": ["error", {
      paths: [{
        name: "ai",
        importNames: [
          "generateText", "streamText", "generateObject", "streamObject", "embed", "embedMany",
          "createGateway", "gateway", "createProviderRegistry", "customProvider", "wrapLanguageModel",
          "Agent", "ToolLoopAgent", "generateImage", "experimental_generateImage", "transcribe",
          "experimental_transcribe", "generateSpeech", "experimental_generateSpeech", "rerank",
        ],
        message: ZDR_MESSAGE,
      }],
      patterns: [{ group: ["@ai-sdk/*", "@anthropic-ai/*", "openai", "@openai/*"], message: ZDR_MESSAGE }],
    }],
    "no-restricted-syntax": ["error",
      { selector: "ImportExpression[source.value=/^(ai|@ai-sdk\\/.*|@anthropic-ai\\/.*|openai)$/]", message: ZDR_MESSAGE },
      { selector: "Literal[value=/ai-gateway\\.vercel\\.sh|api\\.anthropic\\.com|api\\.openai\\.com/]", message: ZDR_MESSAGE },
      { selector: "TemplateElement[value.raw=/ai-gateway\\.vercel\\.sh|api\\.anthropic\\.com|api\\.openai\\.com/]", message: ZDR_MESSAGE },
    ],
  },
};

export default tseslint.config(
  { ignores: ["dist", "node_modules"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  zdrGuard,
);
