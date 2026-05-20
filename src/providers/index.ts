import OpenAI from "openai";
import rawPricing from "./pricing.json";
import { callDeepSeek } from "./deepseek";
import { callKimi } from "./kimi";
import type {
  Provider,
  Model,
  GenerateOptions,
  GenerateResult,
  ModelPricing,
} from "./types";

export type { Provider, Model, GenerateOptions, GenerateResult } from "./types";

// pricing.json has a _meta key we never look up; cast to the usable shape.
const pricing = rawPricing as unknown as Record<string, ModelPricing>;

// ---------------------------------------------------------------------------
// API key resolution
// In the Tauri runtime, keys come from the OS keychain (step 18).
// In Node test environments (Vitest / CI), env vars are used.
// ---------------------------------------------------------------------------

async function resolveApiKey(provider: Provider): Promise<string> {
  if (typeof process !== "undefined") {
    const envVar =
      provider === "deepseek" ? "DEEPSEEK_API_KEY" : "KIMI_API_KEY";
    const key = process.env[envVar];
    if (key) return key;
  }

  // TODO(step-18): invoke Tauri keychain plugin
  throw new Error(
    `No API key for ${provider}. Set ${
      provider === "deepseek" ? "DEEPSEEK_API_KEY" : "KIMI_API_KEY"
    } or configure via Settings.`,
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
// Public API
// ---------------------------------------------------------------------------

export async function generate(
  options: GenerateOptions,
): Promise<GenerateResult> {
  const provider: Provider = options.model.startsWith("deepseek-")
    ? "deepseek"
    : "kimi";

  const apiKey = await resolveApiKey(provider);

  const modelPricing = pricing[options.model as Model];
  if (!modelPricing) {
    throw new Error(`Unknown model: ${options.model}`);
  }

  let lastError: unknown;

  for (let attempt = 0; attempt < 3; attempt++) {
    if (attempt > 0) {
      await sleep(Math.pow(2, attempt - 1) * 1_000);
    }
    try {
      return provider === "deepseek"
        ? await callDeepSeek(options, apiKey, modelPricing)
        : await callKimi(options, apiKey, modelPricing);
    } catch (err) {
      lastError = err;
      if (!isTransient(err) || attempt === 2) throw err;
    }
  }

  throw lastError;
}
