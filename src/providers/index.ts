import OpenAI from "openai";
import rawPricing from "./pricing.json";
import { callDeepSeek } from "./deepseek";
import { callKimi } from "./kimi";
import { callGoogle } from "./google";
import { callOpenAI } from "./openai";
import { callAnthropic } from "./anthropic";
import { generateAzure, testAzureConnection } from "./azure";
import type {
  Provider,
  Model,
  GenerateOptions,
  GenerateResult,
  ModelPricing,
  AzureConfig,
} from "./types";

export type { Provider, Model, GenerateOptions, GenerateResult } from "./types";

// pricing.json has a _meta key we never look up; cast to the usable shape.
const pricing = rawPricing as unknown as Record<string, ModelPricing>;

// ---------------------------------------------------------------------------
// Provider routing
// ---------------------------------------------------------------------------

function getProvider(model: Model): Provider {
  if (model.startsWith("deepseek-")) return "deepseek";
  if (model.startsWith("kimi-")) return "kimi";
  if (model.startsWith("gemini-")) return "google";
  if (model.startsWith("gpt-")) return "openai";
  if (model.startsWith("claude-")) return "anthropic";
  if (model.startsWith("azure-")) return "azure";
  throw new Error(`Unknown provider for model: ${model}`);
}

function envVarForProvider(provider: Provider): string {
  switch (provider) {
    case "deepseek":   return "DEEPSEEK_API_KEY";
    case "kimi":       return "KIMI_API_KEY";
    case "google":     return "GOOGLE_API_KEY";
    case "openai":     return "OPENAI_API_KEY";
    case "anthropic":  return "ANTHROPIC_API_KEY";
    case "azure":      return "AZURE_OPENAI_API_KEY";
  }
}

// ---------------------------------------------------------------------------
// API key resolution
// In the Tauri runtime, keys come from the OS store (passed via --api-key arg
// by the Rust backend or set in process.env by generate.ts).
// In Node test environments (Vitest / CI), env vars are used.
// ---------------------------------------------------------------------------

async function resolveApiKey(provider: Provider): Promise<string> {
  if (typeof process !== "undefined") {
    const envVar = envVarForProvider(provider);
    const key = process.env[envVar];
    if (key) return key;
    // Kimi accepts both KIMI_API_KEY and MOONSHOT_API_KEY
    if (provider === "kimi") {
      const moonshot = process.env["MOONSHOT_API_KEY"];
      if (moonshot) return moonshot;
    }
    // Azure accepts both AZURE_OPENAI_API_KEY and AZURE_API_KEY
    if (provider === "azure") {
      const alt = process.env["AZURE_API_KEY"];
      if (alt) return alt;
    }
  }

  throw new Error(
    `No API key for ${provider}. Set ${envVarForProvider(provider)} or configure via Settings.`,
  );
}

// ---------------------------------------------------------------------------
// Retry helpers
// ---------------------------------------------------------------------------

function isTransient(err: unknown): boolean {
  if (err instanceof OpenAI.APIError) {
    return err.status === 429 || err.status >= 500;
  }
  if (err instanceof Error) {
    const m = err.message.toLowerCase();
    return (
      m.includes("econnreset") ||
      m.includes("etimedout") ||
      m.includes("fetch failed")
    );
  }
  return false;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ---------------------------------------------------------------------------
// Public: generate()
// ---------------------------------------------------------------------------

export async function generate(
  options: GenerateOptions,
): Promise<GenerateResult> {
  const provider = getProvider(options.model);
  const apiKey = await resolveApiKey(provider);

  const modelPricing = pricing[options.model];
  if (!modelPricing) {
    throw new Error(`Unknown model: ${options.model}`);
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(Math.pow(2, attempt - 1) * 1_000);
    }
    try {
      switch (provider) {
        case "deepseek":
          return await callDeepSeek(options, apiKey, modelPricing);
        case "kimi":
          return await callKimi(options, apiKey, modelPricing);
        case "google":
          return await callGoogle(options, apiKey, modelPricing);
        case "openai":
          return await callOpenAI(options, apiKey, modelPricing);
        case "anthropic":
          return await callAnthropic(options, apiKey, modelPricing);
        case "azure": {
          const azureConfig: AzureConfig = {
            endpoint: (typeof process !== "undefined" && process.env["AZURE_OPENAI_ENDPOINT"]) || "",
            deploymentName: (typeof process !== "undefined" && process.env["AZURE_OPENAI_DEPLOYMENT"]) || "",
            apiVersion: "2024-05-01-preview",
            apiKey,
          };
          return await generateAzure(options, azureConfig);
        }
      }
    } catch (err) {
      lastError = err;
      if (!isTransient(err) || attempt === 2) throw err;
    }
  }

  throw lastError;
}

// ---------------------------------------------------------------------------
// Public: testApiConnection()
//
// Used by the Settings screen to verify a newly entered API key.
// Makes a minimal single-token request to the cheapest model for each
// provider.  Works in browser context (dangerouslyAllowBrowser: true is set
// in each provider module).
// ---------------------------------------------------------------------------

const TEST_MODELS: Record<Provider, Model> = {
  deepseek:  "deepseek-v4-flash",
  kimi:      "kimi-k2.6",
  google:    "gemini-2.0-flash",
  openai:    "gpt-4o-mini",
  anthropic: "claude-haiku-4-5",
  azure:     "azure-gpt-4o-mini",
};

const TEST_OPTIONS = {
  systemPrompt: "You are a helpful assistant.",
  userPrompt:   "Reply with OK.",
  maxTokens:    8,
} as const;

export async function testApiConnection(
  provider: Provider,
  apiKey: string,
): Promise<{ success: boolean; latencyMs: number; error?: string }> {
  const start = Date.now();
  const model = TEST_MODELS[provider];
  const modelPricing = pricing[model];

  if (!modelPricing) {
    return { success: false, latencyMs: 0, error: `No pricing data for ${model}` };
  }

  const opts: GenerateOptions = {
    ...TEST_OPTIONS,
    model,
  };

  try {
    switch (provider) {
      case "deepseek":
        await callDeepSeek(opts, apiKey, modelPricing);
        break;
      case "kimi":
        await callKimi(opts, apiKey, modelPricing);
        break;
      case "google":
        await callGoogle(opts, apiKey, modelPricing);
        break;
      case "openai":
        await callOpenAI(opts, apiKey, modelPricing);
        break;
      case "anthropic":
        await callAnthropic(opts, apiKey, modelPricing);
        break;
      case "azure": {
        const azureConfig: AzureConfig = {
          endpoint: (typeof process !== "undefined" && process.env["AZURE_OPENAI_ENDPOINT"]) || "",
          deploymentName: (typeof process !== "undefined" && process.env["AZURE_OPENAI_DEPLOYMENT"]) || "",
          apiVersion: "2024-05-01-preview",
          apiKey,
        };
        await testAzureConnection(azureConfig);
        break;
      }
    }
    return { success: true, latencyMs: Date.now() - start };
  } catch (err) {
    return {
      success: false,
      latencyMs: Date.now() - start,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}
