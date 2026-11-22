import { defineConfig } from "vitest/config";

// Pure functions and a fake R2 binding: the tail handler needs no Workers runtime to test.
export default defineConfig({
  test: { include: ["test/**/*.test.ts"] },
});
