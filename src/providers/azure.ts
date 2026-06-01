/**
 * Azure OpenAI provider — FAO Microsoft 365 enterprise deployment.
 *
 * Uses the openai npm package pointed at an Azure OpenAI resource endpoint.
 * Authentication uses the Azure API key (not a Bearer token).
 *
 * Supported models: azure-gpt-4o, azure-gpt-4o-mini
 * Config env vars: AZURE_OPENAI_ENDPOINT, AZURE_OPENAI_DEPLOYMENT, AZURE_OPENAI_API_KEY
 */

import OpenAI from "openai";
import type { GenerateOptions, GenerateResult, AzureConfig } from "./types";

export async function generateAzure(
  options: GenerateOptions,
  config: AzureConfig,
): Promise<GenerateResult> {
  const start = Date.now();

  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: `${config.endpoint.replace(/\/$/, "")}/openai/deployments/${config.deploymentName}`,
    defaultQuery: { "api-version": config.apiVersion || "2024-05-01-preview" },
    defaultHeaders: { "api-key": config.apiKey },
    dangerouslyAllowBrowser: true,
  });

  const response = await client.chat.completions.create({
    model: config.deploymentName, // Azure ignores the model field but SDK requires it
    messages: [
      { role: "system", content: options.systemPrompt },
      { role: "user", content: options.userPrompt },
    ],
    max_tokens: options.maxTokens ?? 4096,
    temperature: options.temperature ?? 0,
    stream: false,
  });

  const text = response.choices[0]?.message?.content ?? "";
  const inputTokens = response.usage?.prompt_tokens ?? 0;
  const outputTokens = response.usage?.completion_tokens ?? 0;

  const isMini = options.model === "azure-gpt-4o-mini";
  const inputRate = isMini ? 0.15 : 2.50;
  const outputRate = isMini ? 0.60 : 10.00;
  const costUsd =
    (inputTokens / 1_000_000) * inputRate +
    (outputTokens / 1_000_000) * outputRate;

  return {
    text,
    inputTokens,
    outputTokens,
    costUsd,
    wallTimeMs: Date.now() - start,
    provider: "azure",
    model: options.model,
    finishReason:
      response.choices[0]?.finish_reason === "stop" ? "stop" : "length",
  };
}

export async function testAzureConnection(config: AzureConfig): Promise<number> {
  const start = Date.now();
  const client = new OpenAI({
    apiKey: config.apiKey,
    baseURL: `${config.endpoint.replace(/\/$/, "")}/openai/deployments/${config.deploymentName}`,
    defaultQuery: { "api-version": config.apiVersion || "2024-05-01-preview" },
    defaultHeaders: { "api-key": config.apiKey },
    dangerouslyAllowBrowser: true,
  });
  await client.chat.completions.create({
    model: config.deploymentName,
    messages: [{ role: "user", content: "ping" }],
    max_tokens: 5,
  });
  return Date.now() - start;
}
