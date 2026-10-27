import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Proves the lint rule that keeps every model call inside src/explainer/llm.ts actually fires.
const eslint = new ESLint();

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
    expect(await zdrErrors(code, "src/poller/rogue.ts")).toBeGreaterThan(0);
  });

  it("allows non-calling imports from ai elsewhere", async () => {
    expect(await zdrErrors('import { Output } from "ai";\nvoid Output;', "src/poller/ok.ts")).toBe(0);
    expect(await zdrErrors('import type { LanguageModel } from "ai";\nexport type M = LanguageModel;', "src/x.ts")).toBe(0);
  });

  it("allows model calls in src/explainer/llm.ts only", async () => {
    expect(await zdrErrors('import { generateText } from "ai";\nvoid generateText;', "src/explainer/llm.ts")).toBe(0);
    expect(await zdrErrors('import { generateText } from "ai";\nvoid generateText;', "src/explainer/other.ts")).toBeGreaterThan(0);
  });
});
