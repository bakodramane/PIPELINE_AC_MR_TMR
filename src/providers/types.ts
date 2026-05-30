export type Provider = "deepseek" | "kimi" | "google" | "openai" | "anthropic";

export type Model =
  // Tier 1 — Budget
  | "deepseek-v4-flash"
  | "gemini-2.0-flash"
  | "gpt-4o-mini"
  // Tier 2 — Mid-range
  | "deepseek-v4-pro"
  | "kimi-k2.6"
  | "kimi-k2.6-thinking"
  | "gemini-2.5-flash"
  // Tier 3 — Premium
  | "gpt-4o"
  | "gemini-2.5-pro"
  | "claude-opus-4-7";

export interface GenerateOptions {
  systemPrompt: string;
  userPrompt: string;
  model: Model;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: "text" | "json";
  onStream?: (chunk: string) => void;
}

export interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallTimeMs: number;
  provider: Provider;
  model: Model;
  finishReason: "stop" | "length" | "error";
}

export interface ModelPricing {
  inputPerMillion: number;
  outputPerMillion: number;
}

export interface ModelInfo {
  model: Model;
  provider: Provider;
  displayName: string;
  tier: 1 | 2 | 3;
  tierLabel: string;
  inputCostPerM: number;
  outputCostPerM: number;
  contextWindow: number;
  supportsThinking: boolean;
  bestFor: string;
}
