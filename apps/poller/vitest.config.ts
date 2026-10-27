import { cloudflareTest } from "@cloudflare/vitest-plugin";
import { defineConfig } from "vitest/config";

// Runs the tests inside workerd, the Workers runtime, so they prove core works there.
// The Hyperdrive strings are never connected to; Wrangler only needs well-formed values.
const UNUSED_DB = "postgres://test:test@127.0.0.1:1/test";
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_APP ??= UNUSED_DB;
process.env.CLOUDFLARE_HYPERDRIVE_LOCAL_CONNECTION_STRING_HYPERDRIVE_SCHEDULER ??= UNUSED_DB;
// Test-only secrets: an all-zero master key and a dummy gateway key that never reaches a network.
process.env.GUARDBASE_MASTER_KEYS ??= "1:AAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAAA=";
process.env.AI_GATEWAY_API_KEY ??= "test-key";

export default defineConfig({
  plugins: [
    cloudflareTest({
      wrangler: { configPath: "./wrangler.jsonc" },
    }),
  ],
  test: { include: ["test/**/*.test.ts"] },
});
