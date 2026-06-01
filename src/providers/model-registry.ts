/**
 * Model registry — single source of truth for all supported LLM models.
 *
 * Exports:
 *   MODEL_REGISTRY   — flat array of ModelInfo for all 10 models
 *   MODELS_BY_TIER   — grouped by tier (1=Budget, 2=Mid-range, 3=Premium)
 *   DEFAULT_MR_MODEL — default model for MR section generation
 *   DEFAULT_TMR_MODEL — default model for TMR sub-table generation
 */

import type { ModelInfo, Model } from "./types";

export const MODEL_REGISTRY: ModelInfo[] = [
  // ── Tier 1 — Budget ────────────────────────────────────────────────────────
  {
    model: "deepseek-v4-flash",
    provider: "deepseek",
    displayName: "DeepSeek V4 Flash",
    tier: 1,
    tierLabel: "Budget",
    inputCostPerM: 0.14,
    outputCostPerM: 0.28,
    contextWindow: 128_000,
    supportsThinking: false,
    bestFor: "Routine generation, large batches, cost-sensitive runs",
  },
  {
    model: "gemini-2.0-flash",
    provider: "google",
    displayName: "Gemini 2.0 Flash",
    tier: 1,
    tierLabel: "Budget",
    inputCostPerM: 0.10,
    outputCostPerM: 0.40,
    contextWindow: 1_000_000,
    supportsThinking: false,
    bestFor: "Long documents, multi-source evidence, fast turnaround",
  },
  {
    model: "gpt-4o-mini",
    provider: "openai",
    displayName: "GPT-4o mini",
    tier: 1,
    tierLabel: "Budget",
    inputCostPerM: 0.15,
    outputCostPerM: 0.60,
    contextWindow: 128_000,
    supportsThinking: false,
    bestFor: "General-purpose drafts, good OpenAI reliability",
  },

  // ── Tier 2 — Mid-range ─────────────────────────────────────────────────────
  {
    model: "deepseek-v4-pro",
    provider: "deepseek",
    displayName: "DeepSeek V4 Pro",
    tier: 2,
    tierLabel: "Mid-range",
    inputCostPerM: 0.435,
    outputCostPerM: 0.87,
    contextWindow: 128_000,
    supportsThinking: true,
    bestFor: "Complex analysis, structured JSON, reasoning-heavy tasks",
  },
  {
    model: "kimi-k2.6",
    provider: "kimi",
    displayName: "Kimi K2.6",
    tier: 2,
    tierLabel: "Mid-range",
    inputCostPerM: 0.95,
    outputCostPerM: 4.00,
    contextWindow: 128_000,
    supportsThinking: false,
    bestFor: "Multilingual content, Asian census documents",
  },
  {
    model: "kimi-k2.6-thinking",
    provider: "kimi",
    displayName: "Kimi K2.6 Thinking",
    tier: 2,
    tierLabel: "Mid-range",
    inputCostPerM: 0.95,
    outputCostPerM: 4.00,
    contextWindow: 128_000,
    supportsThinking: true,
    bestFor: "Complex reasoning with extended thinking chain",
  },
  {
    model: "gemini-2.5-flash",
    provider: "google",
    displayName: "Gemini 2.5 Flash",
    tier: 2,
    tierLabel: "Mid-range",
    inputCostPerM: 0.15,
    outputCostPerM: 0.60,
    contextWindow: 1_000_000,
    supportsThinking: true,
    bestFor: "Long-context tasks with thinking, cost-effective reasoning",
  },

  // ── Tier 3 — Premium ───────────────────────────────────────────────────────
  {
    model: "gpt-4o",
    provider: "openai",
    displayName: "GPT-4o",
    tier: 3,
    tierLabel: "Premium",
    inputCostPerM: 2.50,
    outputCostPerM: 10.00,
    contextWindow: 128_000,
    supportsThinking: false,
    bestFor: "Highest quality OpenAI output, gold-standard validation",
  },
  {
    model: "gemini-2.5-pro",
    provider: "google",
    displayName: "Gemini 2.5 Pro",
    tier: 3,
    tierLabel: "Premium",
    inputCostPerM: 1.25,
    outputCostPerM: 10.00,
    contextWindow: 2_000_000,
    supportsThinking: true,
    bestFor: "Very long documents, frontier reasoning, 2M context window",
  },
  {
    model: "claude-opus-4-7",
    provider: "anthropic",
    displayName: "Claude Opus 4.7",
    tier: 3,
    tierLabel: "Premium",
    inputCostPerM: 3.00,
    outputCostPerM: 15.00,
    contextWindow: 200_000,
    supportsThinking: true,
    bestFor: "Best narrative quality, nuanced evidence interpretation",
  },

  // ── Azure — FAO enterprise ─────────────────────────────────────────────────
  {
    model: "azure-gpt-4o",
    provider: "azure",
    displayName: "Azure GPT-4o (FAO)",
    tier: 3,
    tierLabel: "Premium",
    inputCostPerM: 2.50,
    outputCostPerM: 10.00,
    contextWindow: 128_000,
    supportsThinking: false,
    bestFor: "FAO enterprise deployment — complex multilingual documents",
  },
  {
    model: "azure-gpt-4o-mini",
    provider: "azure",
    displayName: "Azure GPT-4o mini (FAO)",
    tier: 1,
    tierLabel: "Budget",
    inputCostPerM: 0.15,
    outputCostPerM: 0.60,
    contextWindow: 128_000,
    supportsThinking: false,
    bestFor: "FAO enterprise deployment — routine documents at low cost",
  },
];

export const MODELS_BY_TIER: Record<1 | 2 | 3, ModelInfo[]> = {
  1: MODEL_REGISTRY.filter((m) => m.tier === 1),
  2: MODEL_REGISTRY.filter((m) => m.tier === 2),
  3: MODEL_REGISTRY.filter((m) => m.tier === 3),
};

export const DEFAULT_MR_MODEL: Model = "deepseek-v4-flash";
export const DEFAULT_TMR_MODEL: Model = "deepseek-v4-flash";

/** Lookup ModelInfo by model ID — returns undefined for unknown models. */
export function getModelInfo(model: Model): ModelInfo | undefined {
  return MODEL_REGISTRY.find((m) => m.model === model);
}
