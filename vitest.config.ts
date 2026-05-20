import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["tests/**/*.test.ts"],
    testTimeout: 120_000,
    hookTimeout: 30_000,
    // Run test files sequentially — avoids concurrent DeepSeek / Kimi API calls
    // from two E2E test files racing each other and hitting rate limits or
    // receiving malformed partial responses.
    fileParallelism: false,
  },
});
