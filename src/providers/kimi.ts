import OpenAI from "openai";
import type { GenerateOptions, GenerateResult, ModelPricing } from "./types";

const BASE_URL = "https://api.moonshot.ai/v1";

// Both K2.6 variants share a single API model string; thinking vs. non-thinking
// is distinguished at request time via chat_template_kwargs.
const KIMI_MODEL = "kimi-k2.6";

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

export async function callKimi(
  options: GenerateOptions,
  apiKey: string,
  pricing: ModelPricing,
): Promise<GenerateResult> {
  const client = new OpenAI({
    baseURL: BASE_URL,
    apiKey,
    dangerouslyAllowBrowser: true,
  });

  const isThinking = options.model === "kimi-k2.6-thinking";
  const start = Date.now();

  const messages: OpenAI.Chat.ChatCompletionMessageParam[] = [
    { role: "system", content: options.systemPrompt },
    { role: "user", content: options.userPrompt },
  ];

  // Disable thinking when:
  //   a) The non-thinking model variant is selected (always), or
  //   b) The caller explicitly opts out (disableThinking: true), e.g. TMR data
  //      extraction where reasoning traces consume token budget without gain.
  // The thinking variant retains thinking by default — MR narrative generation
  // benefits from it and does NOT pass disableThinking.
  const shouldDisableThinking = !isThinking || options.disableThinking === true;

  const baseParams = {
    model: KIMI_MODEL,
    messages,
    // Kimi K2.6 API only accepts temperature: 1.0 — override caller's value.
    temperature: 1.0,
    ...(options.maxTokens !== undefined && { max_tokens: options.maxTokens }),
    ...(options.responseFormat === "json" && {
      response_format: { type: "json_object" as const },
    }),
    ...(shouldDisableThinking && {
      extra_body: { thinking: { type: "disabled" } },
    }),
  } as OpenAI.Chat.ChatCompletionCreateParamsNonStreaming;

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
      provider: "kimi",
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
    provider: "kimi",
    model: options.model,
    finishReason: choice.finish_reason === "length" ? "length" : "stop",
  };
}
