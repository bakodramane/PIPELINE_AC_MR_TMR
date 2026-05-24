/**
 * Google Gemini provider — via the OpenAI-compatible endpoint.
 *
 * Uses the same openai npm package as DeepSeek/Kimi but with Google's
 * OpenAI-compatible base URL.  Supports all Gemini models that expose the
 * OpenAI-compatible interface (gemini-2.0-flash, gemini-2.5-flash,
 * gemini-2.5-pro).
 *
 * API key: GOOGLE_API_KEY  (passed as Bearer token via the openai client)
 */

import OpenAI from "openai";
import type { GenerateOptions, GenerateResult, ModelPricing } from "./types";

const BASE_URL = "https://generativelanguage.googleapis.com/v1beta/openai/";

function computeCost(
  inputTokens: number,
  outputTokens: number,
  pricing: ModelPricing,
): number {
  return (
    (inputTokens * pricing.inputPerMillion +
      outputTokens * pricing.outputPerMillion) /
    1_000_000
  );
}

export async function callGoogle(
  options: GenerateOptions,
  apiKey: string,
  pricing: ModelPricing,
): Promise<GenerateResult> {
  const client = new OpenAI({
    baseURL: BASE_URL,
    apiKey,
    dangerouslyAllowBrowser: true,
  });

  const start = Date.now();

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.userPrompt },
  ];

  const baseParams = {
    model: options.model,
    messages,
    ...(options.maxTokens !== undefined && { max_tokens: options.maxTokens }),
    ...(options.temperature !== undefined && {
      temperature: options.temperature,
    }),
    ...(options.responseFormat === "json" && {
      response_format: { type: "json_object" as const },
    }),
  };

  if (options.onStream) {
    const onStream = options.onStream;
    const stream = await client.chat.completions.create({
      ...baseParams,
      stream: true,
    });

    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: GenerateResult["finishReason"] = "stop";

    for await (const chunk of stream) {
      const delta = chunk.choices[0]?.delta?.content ?? "";
      if (delta) {
        text += delta;
        onStream(delta);
      }
      const reason = chunk.choices[0]?.finish_reason;
      if (reason) finishReason = reason === "length" ? "length" : "stop";
      if (chunk.usage) {
        inputTokens = chunk.usage.prompt_tokens;
        outputTokens = chunk.usage.completion_tokens;
      }
    }

    return {
      text,
      inputTokens,
      outputTokens,
      costUsd: computeCost(inputTokens, outputTokens, pricing),
      wallTimeMs: Date.now() - start,
      provider: "google",
      model: options.model,
      finishReason,
    };
  }

  const response = await client.chat.completions.create({
    ...baseParams,
    stream: false,
  });
  const choice = response.choices[0];
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  return {
    text: choice.message.content ?? "",
    inputTokens,
    outputTokens,
    costUsd: computeCost(inputTokens, outputTokens, pricing),
    wallTimeMs: Date.now() - start,
    provider: "google",
    model: options.model,
    finishReason: choice.finish_reason === "length" ? "length" : "stop",
  };
}
