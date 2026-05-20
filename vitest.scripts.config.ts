/**
 * Vitest configuration for standalone E2E run scripts in scripts/.
 *
 * Used by scripts/run-nepal.ts and scripts/run-pakistan.ts.
 * These are NOT part of the regular test suite — they are full pipeline runs
 * that consume real API calls and should only be executed deliberately.
 *
 * Run a script with:
 *   node "C:\Users\Dramane\Desktop\PIPELINE\node_modules\vitest\vitest.mjs" ^
 *     run --root "C:\Users\Dramane\Desktop\PIPELINE" ^
 *     --config vitest.scripts.config.ts ^
 *     --reporter verbose
 */

import { defineConfig } from "vitest/config";

export default defineConfig({
  test: {
    environment: "node",
    include: ["scripts/run-*.ts"],
    // 2-hour test timeout — each script runs 15 MR sections + 23 TMR sub-tables
    testTimeout: 7_200_000,
    hookTimeout: 60_000,
    // Scripts must run sequentially — both share the DeepSeek API key and
    // concurrent calls cause rate-limit errors.
    fileParallelism: false,
  },
});
