import OpenAI from "openai";
import type { GenerateOptions, GenerateResult, ModelPricing } from "./types";

const BASE_URL = "https://api.deepseek.com/v1";

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

export async function callDeepSeek(
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

  // V4-Flash always disables thinking (API requires it — content is empty otherwise).
  // V4-Pro disables thinking when disableThinking: true is passed by the caller
  // (e.g. TMR data-extraction, where reasoning traces consume budget without gain).
  // V4-Pro without the flag keeps thinking enabled — MR narrative generation benefits.
  //
  // IMPORTANT: When thinking is enabled on V4-Pro, thinking tokens count against
  // max_tokens.  Without a thinking budget cap, the thinking trace fills the entire
  // max_tokens allocation before the actual answer is written → parse_failed + truncated.
  // Fix: (a) set an explicit thinking budget so thinking has its own cap, and
  //      (b) add that budget to max_tokens so the answer still gets its full allocation.
  const THINKING_BUDGET_TOKENS = 2_000;

  const thinkingParam =
    options.model === "deepseek-v4-flash" || options.disableThinking === true
      ? { thinking: { type: "disabled" } }
      : options.model === "deepseek-v4-pro"
      ? { thinking: { type: "enabled", budget_tokens: THINKING_BUDGET_TOKENS } }
      : {};

  // For V4-Pro with thinking enabled, total max_tokens must cover both the
  // thinking trace (≤ THINKING_BUDGET_TOKENS) and the actual answer.
  const isThinkingEnabled =
    options.model === "deepseek-v4-pro" && options.disableThinking !== true;
  const effectiveMaxTokens =
    options.maxTokens !== undefined && isThinkingEnabled
      ? options.maxTokens + THINKING_BUDGET_TOKENS
      : options.maxTokens;

  const baseParams = {
    model: options.model,
    messages,
    ...(effectiveMaxTokens !== undefined && { max_tokens: effectiveMaxTokens }),
    ...(options.temperature !== undefined && {
      temperature: options.temperature,
    }),
    ...(options.responseFormat === "json" && {
      response_format: { type: "json_object" as const },
    }),
    ...thinkingParam,
  };

  if (options.onStream) {
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
        options.onStream(delta);
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
      provider: "deepseek",
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
    provider: "deepseek",
    model: options.model,
    finishReason: choice.finish_reason === "length" ? "length" : "stop",
  };
}
