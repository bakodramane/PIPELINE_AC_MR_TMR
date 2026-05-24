/**
 * Anthropic provider — using the @anthropic-ai/sdk directly.
 *
 * Anthropic does NOT use the standard OpenAI response format for streaming
 * (different event type names), so we use the official SDK rather than the
 * OpenAI npm package with a compatibility shim.
 *
 * Supports claude-opus-4-7 (Tier 3 — Premium).
 *
 * API key: ANTHROPIC_API_KEY
 */

import Anthropic from "@anthropic-ai/sdk";
import type { GenerateOptions, GenerateResult, ModelPricing } from "./types";

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

export async function callAnthropic(
  options: GenerateOptions,
  apiKey: string,
  pricing: ModelPricing,
): Promise<GenerateResult> {
  const client = new Anthropic({
    apiKey,
    dangerouslyAllowBrowser: true,
  });

  const start = Date.now();

  const createParams: Anthropic.Messages.MessageCreateParamsNonStreaming = {
    model: options.model,
    max_tokens: options.maxTokens ?? 8192,
    system: options.systemPrompt,
    messages: [{ role: "user", content: options.userPrompt }],
    ...(options.temperature !== undefined && {
      temperature: options.temperature,
    }),
  };

  if (options.onStream) {
    const onStream = options.onStream;
    let text = "";
    let inputTokens = 0;
    let outputTokens = 0;
    let finishReason: GenerateResult["finishReason"] = "stop";

    const stream = client.messages.stream({
      ...createParams,
    });

    stream.on("text", (chunk) => {
      text += chunk;
      onStream(chunk);
    });

    const finalMsg = await stream.finalMessage();
    inputTokens = finalMsg.usage.input_tokens;
    outputTokens = finalMsg.usage.output_tokens;
    if (finalMsg.stop_reason === "max_tokens") finishReason = "length";

    return {
      text,
      inputTokens,
      outputTokens,
      costUsd: computeCost(inputTokens, outputTokens, pricing),
      wallTimeMs: Date.now() - start,
      provider: "anthropic",
      model: options.model,
      finishReason,
    };
  }

  // Non-streaming path
  const response = await client.messages.create(createParams);

  const inputTokens = response.usage.input_tokens;
  const outputTokens = response.usage.output_tokens;
  const firstBlock = response.content[0];
  const text =
    firstBlock && firstBlock.type === "text" ? firstBlock.text : "";
  const finishReason: GenerateResult["finishReason"] =
    response.stop_reason === "max_tokens" ? "length" : "stop";

  return {
    text,
    inputTokens,
    outputTokens,
    costUsd: computeCost(inputTokens, outputTokens, pricing),
    wallTimeMs: Date.now() - start,
    provider: "anthropic",
    model: options.model,
    finishReason,
  };
}
