import { fileURLToPath } from "node:url";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

// Proves the two web-app lint rules fire (eslint.config.js): the billing gate (decision 028) and
// "no AI in the web app". ESLint runs from the repo root, where its config lives.
const root = fileURLToPath(new URL("../../..", import.meta.url));
const eslint = new ESLint({ cwd: root });

async function errors(code: string, filePath: string, text: string): Promise<number> {
  const [result] = await eslint.lintText(code, { filePath });
  return result!.messages.filter((m) => m.message.includes(text)).length;
}

const UNGATED = 'import { withTenantForUser } from "@supahound/core/db/user";\nvoid withTenantForUser;';

describe("web app lint guards", () => {
  it.each([
    "apps/web/app/w/[tenantId]/page.tsx",
    "apps/web/app/w/[tenantId]/projects/actions.ts",
    "apps/web/app/api/supabase/callback/route.ts",
    "apps/web/lib/picker.ts",
    // A project's settings are gated; only the workspace settings page is not (decision 037).
    "apps/web/app/w/[tenantId]/p/[projectId]/settings/page.tsx",
  ])("blocks withTenantForUser in %s", async (file) => {
    expect(await errors(UNGATED, file, "withPaidTenantForUser")).toBeGreaterThan(0);
  });

  it("allows withTenantForUser in the billing and data-controls routes only", async () => {
    expect(await errors(UNGATED, "apps/web/app/w/[tenantId]/billing/page.tsx", "withPaidTenantForUser")).toBe(0);
    expect(await errors(UNGATED, "apps/web/app/w/[tenantId]/settings/actions.ts", "withPaidTenantForUser")).toBe(0);
    expect(await errors(UNGATED, "apps/web/app/w/[tenantId]/closed/page.tsx", "withPaidTenantForUser")).toBe(0);
    expect(await errors(UNGATED, "apps/web/app/w/[tenantId]/billing/return/route.ts", "withPaidTenantForUser")).toBe(0);
    expect(await errors(UNGATED, "packages/core/src/billing/flow.ts", "withPaidTenantForUser")).toBe(0);
  });

  it.each([
    ['import type { LanguageModel } from "ai";\nexport type M = LanguageModel;', "a type import from ai"],
    ['import { Output } from "ai";\nvoid Output;', "a non-calling import from ai"],
    ['import { explainerFor } from "@supahound/core/explainer/llm";\nvoid explainerFor;', "the explainer"],
  ])("blocks %s anywhere in the web app, billing routes included", async (code) => {
    for (const file of ["apps/web/app/page.tsx", "apps/web/components/X.tsx", "apps/web/app/w/[tenantId]/billing/page.tsx"]) {
      expect(await errors(code, file, "runs no AI"), file).toBeGreaterThan(0);
    }
  });

  it("keeps the ZDR guard in the web app", async () => {
    expect(await errors('import { generateText } from "ai";\nvoid generateText;', "apps/web/app/page.tsx", "zero data retention")).toBeGreaterThan(0);
  });

  it("leaves the poller free to use the explainer", async () => {
    expect(await errors('import { explainerFor } from "@supahound/core/explainer/llm";\nvoid explainerFor;', "apps/poller/src/index.ts", "runs no AI")).toBe(0);
  });
});
