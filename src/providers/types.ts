export type Provider = "deepseek" | "kimi" | "google" | "openai" | "anthropic" | "azure";

export type Model =
  // Tier 1 — Budget
  | "deepseek-v4-flash"
  | "gemini-2.0-flash"
  | "gpt-4o-mini"
  | "claude-haiku-4-5"
  // Tier 2 — Mid-range
  | "deepseek-v4-pro"
  | "kimi-k2.6"
  | "kimi-k2.6-thinking"
  | "gemini-2.5-flash"
  | "claude-sonnet-4-6"
  // Tier 3 — Premium
  | "gpt-4o"
  | "gemini-2.5-pro"
  | "claude-opus-4-8"
  // Azure — FAO enterprise
  | "azure-gpt-4o"
  | "azure-gpt-4o-mini";

export interface GenerateOptions {
  systemPrompt: string;
  userPrompt: string;
  model: Model;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: "text" | "json";
  onStream?: (chunk: string) => void;
  /**
   * When true, explicitly disable thinking on models that support it
   * (currently DeepSeek V4 Pro).  Use for data-extraction tasks where
   * reasoning traces consume token budget without improving accuracy.
   */
  disableThinking?: boolean;
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

export interface AzureConfig {
  endpoint: string;       // e.g. https://fao-openai.openai.azure.com
  deploymentName: string; // e.g. gpt-4o
  apiVersion: string;     // default: 2024-05-01-preview
  apiKey: string;
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
