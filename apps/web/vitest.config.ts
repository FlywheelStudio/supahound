import { defineConfig } from "vitest/config";

// Unit tests for the pure, security-sensitive helpers in lib/ (no Workers bindings needed).
export default defineConfig({
  test: { include: ["test/**/*.test.ts"], environment: "node" },
});
