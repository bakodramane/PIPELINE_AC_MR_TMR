/**
 * Integration tests for the provider abstraction module.
 *
 * Tests hit real APIs and are skipped when the required env vars are absent,
 * so they are safe to run in CI without credentials.
 *
 * To run locally:
 *   DEEPSEEK_API_KEY=sk-... KIMI_API_KEY=sk-... npm test
 */

import { describe, it, expect } from "vitest";
import { generate } from "../src/providers/index";
import type { GenerateResult } from "../src/providers/index";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const TRIVIAL_SYSTEM = "You are a helpful assistant. Be concise.";
const TRIVIAL_USER = 'Reply with exactly the word "pong" and nothing else.';

function assertResultShape(
  result: GenerateResult,
  expectedProvider: "deepseek" | "kimi",
) {
  expect(result.text).toBeTruthy();
  expect(typeof result.text).toBe("string");

  expect(result.inputTokens).toBeGreaterThan(0);
  expect(result.outputTokens).toBeGreaterThan(0);

  // costUsd must be non-negative and consistent with token counts and pricing
  expect(result.costUsd).toBeGreaterThan(0);
  expect(typeof result.costUsd).toBe("number");
  expect(Number.isFinite(result.costUsd)).toBe(true);

  expect(result.wallTimeMs).toBeGreaterThan(0);
  expect(result.provider).toBe(expectedProvider);
  expect(["stop", "length", "error"]).toContain(result.finishReason);
}

function assertCostCalculation(result: GenerateResult) {
  // Cost must scale with token counts — a rough sanity check.
  // Even at the cheapest rate ($0.14/M in + $0.28/M out), a minimal call
  // with ~20 input and ~5 output tokens should produce a tiny but non-zero cost.
  const minCostAtCheapestRate =
    (result.inputTokens * 0.14 + result.outputTokens * 0.28) / 1_000_000;
  expect(result.costUsd).toBeGreaterThanOrEqual(minCostAtCheapestRate * 0.99); // allow rounding
}

// ---------------------------------------------------------------------------
// DeepSeek tests (gated on DEEPSEEK_API_KEY)
// ---------------------------------------------------------------------------

const deepseekKey = process.env["DEEPSEEK_API_KEY"];

describe.skipIf(!deepseekKey)("DeepSeek provider", () => {
  it(
    "deepseek-v4-flash: returns a valid GenerateResult",
    async () => {
      const result = await generate({
        systemPrompt: TRIVIAL_SYSTEM,
        userPrompt: TRIVIAL_USER,
        model: "deepseek-v4-flash",
        maxTokens: 64,
      });

      assertResultShape(result, "deepseek");
      assertCostCalculation(result);
      expect(result.model).toBe("deepseek-v4-flash");
    },
    60_000,
  );

  it(
    "deepseek-v4-pro: returns a valid GenerateResult",
    async () => {
      const result = await generate({
        systemPrompt: TRIVIAL_SYSTEM,
        userPrompt: TRIVIAL_USER,
        model: "deepseek-v4-pro",
        maxTokens: 1024,
      });

      assertResultShape(result, "deepseek");
      assertCostCalculation(result);
      expect(result.model).toBe("deepseek-v4-pro");
    },
    60_000,
  );

  it(
    "deepseek-v4-flash: cost matches pricing.json for returned token counts",
    async () => {
      const result = await generate({
        systemPrompt: TRIVIAL_SYSTEM,
        userPrompt: TRIVIAL_USER,
        model: "deepseek-v4-flash",
        maxTokens: 64,
      });

      // Flash pricing: $0.14/M input, $0.28/M output
      const expected =
        (result.inputTokens * 0.14 + result.outputTokens * 0.28) / 1_000_000;
      expect(result.costUsd).toBeCloseTo(expected, 10);
    },
    60_000,
  );
});

// ---------------------------------------------------------------------------
// Kimi tests (gated on KIMI_API_KEY)
// ---------------------------------------------------------------------------

const kimiKey = process.env["KIMI_API_KEY"];

describe.skipIf(!kimiKey)("Kimi provider", () => {
  it(
    "kimi-k2.6-non-thinking: returns a valid GenerateResult",
    async () => {
      const result = await generate({
        systemPrompt: TRIVIAL_SYSTEM,
        userPrompt: TRIVIAL_USER,
        model: "kimi-k2.6-non-thinking",
        maxTokens: 512,
      });

      assertResultShape(result, "kimi");
      assertCostCalculation(result);
      expect(result.model).toBe("kimi-k2.6-non-thinking");
    },
    120_000,
  );

  it(
    "kimi-k2.6-thinking: returns a valid GenerateResult",
    async () => {
      const result = await generate({
        systemPrompt: TRIVIAL_SYSTEM,
        userPrompt: TRIVIAL_USER,
        model: "kimi-k2.6-thinking",
        maxTokens: 64,
      });

      assertResultShape(result, "kimi");
      assertCostCalculation(result);
      expect(result.model).toBe("kimi-k2.6-thinking");
    },
    120_000,
  );

  it(
    "kimi-k2.6-non-thinking: cost matches pricing.json for returned token counts",
    async () => {
      const result = await generate({
        systemPrompt: TRIVIAL_SYSTEM,
        userPrompt: TRIVIAL_USER,
        model: "kimi-k2.6-non-thinking",
        maxTokens: 512,
      });

      // Kimi pricing: $0.95/M input, $4.00/M output
      const expected =
        (result.inputTokens * 0.95 + result.outputTokens * 4.0) / 1_000_000;
      expect(result.costUsd).toBeCloseTo(expected, 10);
    },
    120_000,
  );
});

// ---------------------------------------------------------------------------
// Unit-level: model routing (no API keys needed)
// ---------------------------------------------------------------------------

describe("model routing (no API needed)", () => {
  it("throws a clear error when no API key is configured for deepseek", async () => {
    const saved = process.env["DEEPSEEK_API_KEY"];
    delete process.env["DEEPSEEK_API_KEY"];

    await expect(
      generate({
        systemPrompt: "s",
        userPrompt: "u",
        model: "deepseek-v4-flash",
      }),
    ).rejects.toThrow(/DEEPSEEK_API_KEY/);

    if (saved !== undefined) process.env["DEEPSEEK_API_KEY"] = saved;
  });

  it("throws a clear error when no API key is configured for kimi", async () => {
    const saved = process.env["KIMI_API_KEY"];
    delete process.env["KIMI_API_KEY"];

    await expect(
      generate({
        systemPrompt: "s",
        userPrompt: "u",
        model: "kimi-k2.6-non-thinking",
      }),
    ).rejects.toThrow(/KIMI_API_KEY/);

    if (saved !== undefined) process.env["KIMI_API_KEY"] = saved;
  });
});
