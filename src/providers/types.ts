export type Provider = "deepseek" | "kimi";

export type Model =
  | "deepseek-v4-flash"
  | "deepseek-v4-pro"
  | "kimi-k2.6-non-thinking"
  | "kimi-k2.6-thinking";

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
