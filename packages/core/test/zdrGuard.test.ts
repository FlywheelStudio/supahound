import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Proves the lint rule that keeps every model call inside packages/core/src/explainer/llm.ts fires,
// in every package of the workspace. ESLint runs from the repo root, where its config lives.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const eslint = new ESLint({ cwd: root });

async function zdrErrors(code: string, filePath: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.message.includes("zero data retention")).length;
}

describe("ZDR lint guard", () => {
  it.each([
    ['import { generateText } from "ai";\nvoid generateText;', "generateText from ai"],
    ['import { streamText as s } from "ai";\nvoid s;', "aliased streamText"],
    ['import { createGateway } from "ai";\nvoid createGateway;', "createGateway"],
    ['import { anthropic } from "@ai-sdk/anthropic";\nvoid anthropic;', "a direct provider package"],
    ['import Anthropic from "@anthropic-ai/sdk";\nvoid Anthropic;', "the Anthropic SDK"],
    ['import OpenAI from "openai";\nvoid OpenAI;', "the OpenAI SDK"],
    ['export const m = await import("ai");', "a dynamic import"],
    // Split so this test file does not trip the rule it tests.
    [`export const u = "https://ai-gateway${".vercel.sh"}/v3/ai";`, "a hard-coded gateway URL"],
    ["export const u = `https://api.anthropic" + ".com/v1/messages`;", "a hard-coded vendor URL in a template"],
  ])("blocks %s (%s) outside the explainer", async (code) => {
    expect(await zdrErrors(code, "packages/core/src/poller/rogue.ts")).toBeGreaterThan(0);
  });

  it.each(["packages/core/src/x.mts", "packages/core/src/x.cts", "apps/web/app/page.tsx", "apps/poller/src/x.mjs"])("covers %s files too", async (filePath) => {
    expect(await zdrErrors('import { generateText } from "ai";\nvoid generateText;', filePath)).toBeGreaterThan(0);
  });

  it("allows non-calling imports from ai elsewhere", async () => {
    expect(await zdrErrors('import { Output } from "ai";\nvoid Output;', "packages/core/src/poller/ok.ts")).toBe(0);
    expect(await zdrErrors('import type { LanguageModel } from "ai";\nexport type M = LanguageModel;', "apps/web/lib/x.ts")).toBe(0);
  });

  it("allows model calls in packages/core/src/explainer/llm.ts only", async () => {
    expect(await zdrErrors('import { generateText } from "ai";\nvoid generateText;', "packages/core/src/explainer/llm.ts")).toBe(0);
    expect(await zdrErrors('import { generateText } from "ai";\nvoid generateText;', "packages/core/src/explainer/other.ts")).toBeGreaterThan(0);
    expect(await zdrErrors('import { generateText } from "ai";\nvoid generateText;', "apps/web/app/api/x/route.ts")).toBeGreaterThan(0);
    expect(await zdrErrors('import { generateText } from "ai";\nvoid generateText;', "apps/poller/src/index.ts")).toBeGreaterThan(0);
  });
});
