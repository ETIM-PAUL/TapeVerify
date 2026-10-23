import { defineConfig } from "vitest/config";

// Load tests: slower than the regular suite, with timings printed. Run with `pnpm --filter @tapeverify/workers perf`.
export default defineConfig({
  test: {
    include: ["perf/**/*.perf.ts"],
    globalSetup: ["test/global-setup.ts"],
    fileParallelism: false,
    testTimeout: 600_000,
    hookTimeout: 600_000,
  },
});
