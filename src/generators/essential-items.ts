/**
 * WCA 2020 Essential Items coverage assessment generator.
 *
 * For each of the 23 WCA 2020 essential items, retrieves evidence from the
 * project's indexed source documents and asks the model whether the item was
 * collected in the census questionnaire.
 *
 * Output:  drafts/essential-items/_assessment.json
 *          {
 *            items:   { [code]: EssentialItemResult }
 *            summary: AssessmentSummary
 *          }
 *
 * Mirrors the TMR per-item loop pattern: one API call per item, sequential,
 * with individual DONE/ERROR stdout lines for the sidecar progress protocol.
 */

import { readFile, writeFile, mkdir, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generate } from "../providers/index";
import type { Model } from "../providers/types";
import { retrieveEvidence } from "./evidence";
import { appendAuditEvent } from "../project/io";
import type { AuditEvent, PageJson } from "../project/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PROMPT_VERSION = "v1.0";

const RESOURCE_ROOT = process.env["AGCENSUS_RESOURCE_ROOT"] ?? null;

const WCA_ESSENTIAL_ITEMS_PATH = RESOURCE_ROOT
  ? path.join(RESOURCE_ROOT, "concepts", "wca-essential-items.json")
  : path.resolve(__dirname, "..", "concepts", "wca-essential-items.json");

/**
 * Maximum evidence pages retrieved per item.
 * Kept at 10 (same as MR default) — enough to find questionnaire questions
 * while keeping cost low across 23 calls.
 */
const MAX_EVIDENCE_PAGES = 10;

/** Max tokens for the model response per item. */
const MAX_TOKENS = 1024;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EssentialItemDefinition {
  code: string;
  name: string;
  theme: string;
  short_description: string;
  is_new: boolean;
}

export type CollectionStatus = "collected" | "partial" | "not_collected" | "unclear";
export type ConfidenceLevel = "high" | "medium" | "low";

export interface EssentialItemResult {
  code: string;
  name: string;
  theme: string;
  is_new: boolean;
  status: CollectionStatus;
  questionnaire_section: string;
  question_numbers: string[];
  evidence_excerpt: string;
  explanation: string;
  confidence: ConfidenceLevel;
  notes: string;
  source_pages: string[];
}

export interface AssessmentSummary {
  collected: number;
  partial: number;
  not_collected: number;
  unclear: number;
  total_assessed: number;
  headline: string;
  questionnaire_indexed: boolean;
  generated_at: string;
}

export interface AssessmentJson {
  items: Record<string, EssentialItemResult>;
  summary: AssessmentSummary;
}

// Model response shape (one item)
interface ModelItemResponse {
  code: string;
  status: CollectionStatus;
  questionnaire_section: string;
  question_numbers: string[];
  evidence_excerpt: string;
  explanation: string;
  confidence: ConfidenceLevel;
  notes: string;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

function extractJson(text: string): string | null {
  let s = text.replace(/```json\s*/gi, "").replace(/```\s*/g, "").trim();
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, "").trim();
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, "").trim();
  s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, "").trim();
  const start = s.indexOf("{");
  const end = s.lastIndexOf("}");
  if (start === -1 || end === -1 || end <= start) return null;
  return s.slice(start, end + 1);
}

function truncateExcerpt(text: string): string {
  if (!text) return "";
  const words = text.trim().split(/\s+/);
  return words.length <= 15 ? text.trim() : words.slice(0, 15).join(" ") + "…";
}

/**
 * Detect whether any indexed source appears to be a census questionnaire.
 * Checks doc id and filename for keywords: quest, form, questionnaire.
 * Also checks the evidence index for "questionnaire" in page headings.
 */
async function detectQuestionnaireIndexed(projectDir: string): Promise<boolean> {
  // Check sources/_index.json
  try {
    const indexPath = path.join(projectDir, "sources", "_index.json");
    const sources = await readJson<Array<{ id: string; filename?: string }>>(indexPath);
    const kwRe = /quest|questionnaire|formulaire|cuestionario|formulario/i;
    for (const s of sources) {
      if (kwRe.test(s.id) || kwRe.test(s.filename ?? "")) return true;
    }
  } catch {
    // _index.json absent — fall through
  }

  // Check evidence/_evidence.json page headings
  try {
    const evidencePath = path.join(projectDir, "evidence", "_evidence.json");
    const ev = await readJson<{ pages: Array<{ headings: string[] }> }>(evidencePath);
    const kwRe = /questionnaire|question|questionnary/i;
    for (const p of ev.pages) {
      if (p.headings.some((h) => kwRe.test(h))) return true;
    }
  } catch {
    // ignore
  }

  return false;
}

function computeSummary(
  items: Record<string, EssentialItemResult>,
  questionnaireIndexed: boolean,
): AssessmentSummary {
  let collected = 0;
  let partial = 0;
  let not_collected = 0;
  let unclear = 0;

  for (const item of Object.values(items)) {
    switch (item.status) {
      case "collected":    collected++;    break;
      case "partial":      partial++;      break;
      case "not_collected": not_collected++; break;
      case "unclear":      unclear++;      break;
    }
  }

  const total_assessed = collected + partial + not_collected + unclear;
  const headline = `${collected} of 23 WCA essential items collected`;

  return {
    collected,
    partial,
    not_collected,
    unclear,
    total_assessed,
    headline,
    questionnaire_indexed: questionnaireIndexed,
    generated_at: new Date().toISOString(),
  };
}

function buildSystemPrompt(): string {
  return `You are a WCA 2020 agricultural census evaluation assistant.

Your task: given evidence pages from a country's agricultural census documents, determine whether a specific WCA 2020 essential item was collected in the census.

Key rules:
1. DO NOT assume an item was collected without clear evidence in the pages provided.
2. The strongest evidence is an actual questionnaire question that collects this information.
3. If the evidence is only a narrative mention in the report (not a questionnaire question), you may still mark "collected" but use lower confidence and note this in the notes field.
4. If you find partial coverage (e.g. only sex but not age is collected for an item requiring both), mark "partial" and explain what is covered versus missing.
5. If there is no evidence of collection, mark "not_collected".
6. Use "unclear" only when evidence is ambiguous or contradictory.
7. Keep evidence_excerpt under 15 words — cite the exact words from the source, never reproduce long passages.
8. question_numbers should be the actual question or form field identifiers (e.g. "Q3", "A.2", "Section B item 4"). Use an empty array if not identifiable.
9. Return ONLY a valid JSON object with no markdown fences or preamble.`;
}

function buildUserPrompt(
  item: EssentialItemDefinition,
  pages: PageJson[],
): string {
  const evidenceBlock =
    pages.length === 0
      ? "(No matching evidence pages were found in the evidence store.)"
      : pages
          .map((p) => `[Page ${p.page_id}, p.${p.page_number}]\n${p.text}`)
          .join("\n\n---\n\n");

  return `## Essential Item to Assess

Code: ${item.code}
Name: ${item.name}
Theme: ${item.theme}
Description: ${item.short_description}

## Evidence Pages

The following pages were retrieved from the indexed census documents. Determine whether item ${item.code} was collected, based strictly on this evidence.

${evidenceBlock}

## Instructions

Return a JSON object with exactly this structure:

{
  "code": "${item.code}",
  "status": "collected" | "partial" | "not_collected" | "unclear",
  "questionnaire_section": "name or number of the questionnaire section, or empty string",
  "question_numbers": ["Q1", "A.2"],
  "evidence_excerpt": "concise excerpt under 15 words from the source",
  "explanation": "one to two sentences explaining why you assigned this status",
  "confidence": "high" | "medium" | "low",
  "notes": "any caveats, partial coverage details, or observations"
}

Status guidance:
- "collected": clear evidence the item is asked in the questionnaire or definitively collected
- "partial": some but not all aspects of the item are covered (explain in notes)
- "not_collected": evidence confirms or strongly suggests the item was not collected
- "unclear": evidence is ambiguous or absent — do not speculate

Confidence guidance:
- "high": found an actual questionnaire question for this item
- "medium": strong narrative evidence but no visible questionnaire question
- "low": indirect evidence only, or evidence found after keyword fallback`;
}

/**
 * Post-process: enforce evidence discipline.
 * If status is "collected" or "partial" but no source pages were provided,
 * downgrade to "unclear".
 */
function enforceEvidenceDiscipline(
  result: EssentialItemResult,
  sourcePages: string[],
): EssentialItemResult {
  if (
    (result.status === "collected" || result.status === "partial") &&
    sourcePages.length === 0
  ) {
    return {
      ...result,
      status: "unclear",
      notes: result.notes
        ? `${result.notes} [Auto-downgraded from ${result.status}: no source pages available.]`
        : `Auto-downgraded from ${result.status}: no source pages were provided.`,
    };
  }
  return result;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Assess WCA 2020 essential-items coverage for one country project.
 *
 * @param projectDir  Absolute path to the country project directory.
 * @param model       The model to use for generation.
 * @param itemCode    When set, assess only this item (4-digit code). When null,
 *                    assess all 23 items sequentially.
 * @param onProgress  Optional callback invoked after each item completes,
 *                    used by the sidecar script to emit DONE/ERROR lines.
 */
export async function assessEssentialItems(
  projectDir: string,
  model: Model,
  itemCode: string | null = null,
  onProgress?: (index: number, code: string, ok: boolean, errorMsg?: string) => void,
): Promise<void> {
  // ── 0. Load essential items registry ─────────────────────────────────────
  const allItems = await readJson<EssentialItemDefinition[]>(WCA_ESSENTIAL_ITEMS_PATH);

  const itemsToProcess = itemCode
    ? allItems.filter((item) => item.code === itemCode)
    : allItems;

  if (itemsToProcess.length === 0) {
    const msg = itemCode
      ? `No essential item with code "${itemCode}" found in registry.`
      : "Essential items registry is empty.";
    onProgress?.(0, itemCode ?? "", false, msg);
    return;
  }

  // ── 1. Ensure output directory exists ─────────────────────────────────────
  const assessmentDir = path.join(projectDir, "drafts", "essential-items");
  await mkdir(assessmentDir, { recursive: true });
  const assessmentPath = path.join(assessmentDir, "_assessment.json");

  // ── 2. Load existing assessment (or start fresh) ──────────────────────────
  let assessment: AssessmentJson;
  try {
    assessment = await readJson<AssessmentJson>(assessmentPath);
    if (!assessment.items || typeof assessment.items !== "object") {
      assessment = { items: {}, summary: computeSummary({}, false) };
    }
  } catch {
    assessment = { items: {}, summary: computeSummary({}, false) };
  }

  const pagesDir = path.join(projectDir, "evidence", "pages");

  let totalInputTokens = 0;
  let totalOutputTokens = 0;
  let totalCostUsd = 0;
  let lastModel: Model = model;
  let lastProvider = "";
  const wallStart = Date.now();

  // ── 3. Per-item loop ──────────────────────────────────────────────────────
  for (let i = 0; i < itemsToProcess.length; i++) {
    const item = itemsToProcess[i]!;
    const itemIndex = allItems.findIndex((x) => x.code === item.code) + 1; // 1-based

    // Retrieve evidence: combine item name and first sentence of description as keywords
    const descFirst = item.short_description.split(".")[0] ?? item.short_description;
    const keywords = [
      item.name.toLowerCase(),
      ...descFirst.toLowerCase().split(/\s+/).filter((w) => w.length > 4),
    ];

    const pages = await retrieveEvidence(projectDir, keywords, MAX_EVIDENCE_PAGES, "mr");
    const sourcePageIds = pages.map((p) => p.page_id);

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(item, pages);

    const callStart = Date.now();
    const result = await generate({
      systemPrompt,
      userPrompt,
      model,
      maxTokens: MAX_TOKENS,
      temperature: 0,
      disableThinking: true,
    });
    const wallMs = Date.now() - callStart;

    totalInputTokens += result.inputTokens;
    totalOutputTokens += result.outputTokens;
    totalCostUsd += result.costUsd;
    lastModel = result.model;
    lastProvider = result.provider;

    // Parse the response
    const extracted = extractJson(result.text);
    let parsed: ModelItemResponse | null = null;
    let parseFailed = false;

    try {
      if (!extracted) throw new Error("No JSON object found in response");
      parsed = JSON.parse(extracted) as ModelItemResponse;
      if (!parsed.status) throw new Error("Response missing 'status' field");
    } catch {
      parseFailed = true;
    }

    if (parseFailed || !parsed) {
      // Store as unclear with a note
      const fallback: EssentialItemResult = {
        code: item.code,
        name: item.name,
        theme: item.theme,
        is_new: item.is_new,
        status: "unclear",
        questionnaire_section: "",
        question_numbers: [],
        evidence_excerpt: "",
        explanation: "Assessment could not be completed — model response could not be parsed.",
        confidence: "low",
        notes: `Parse failed. Raw response preview: ${result.text.slice(0, 100)}`,
        source_pages: sourcePageIds,
      };
      assessment.items[item.code] = fallback;
    } else {
      // Validate status value
      const validStatuses: CollectionStatus[] = ["collected", "partial", "not_collected", "unclear"];
      const status: CollectionStatus = validStatuses.includes(parsed.status as CollectionStatus)
        ? (parsed.status as CollectionStatus)
        : "unclear";

      // Validate confidence value
      const validConf: ConfidenceLevel[] = ["high", "medium", "low"];
      const confidence: ConfidenceLevel = validConf.includes(parsed.confidence as ConfidenceLevel)
        ? (parsed.confidence as ConfidenceLevel)
        : "low";

      let itemResult: EssentialItemResult = {
        code: item.code,
        name: item.name,
        theme: item.theme,
        is_new: item.is_new,
        status,
        questionnaire_section: parsed.questionnaire_section ?? "",
        question_numbers: Array.isArray(parsed.question_numbers) ? parsed.question_numbers : [],
        evidence_excerpt: truncateExcerpt(parsed.evidence_excerpt ?? ""),
        explanation: parsed.explanation ?? "",
        confidence,
        notes: parsed.notes ?? "",
        source_pages: sourcePageIds,
      };

      // Enforce evidence discipline
      itemResult = enforceEvidenceDiscipline(itemResult, sourcePageIds);

      // Verify at least one cited page exists (for "collected"/"partial")
      if (itemResult.status === "collected" || itemResult.status === "partial") {
        let anyPageExists = false;
        for (const pageId of sourcePageIds.slice(0, 5)) {
          try {
            await access(path.join(pagesDir, `${pageId}.json`));
            anyPageExists = true;
            break;
          } catch {
            // continue
          }
        }
        if (!anyPageExists && sourcePageIds.length === 0) {
          itemResult.status = "unclear";
          itemResult.notes = (itemResult.notes ? itemResult.notes + " " : "") +
            "[Auto-downgraded: no evidence pages available.]";
        }
      }

      assessment.items[item.code] = itemResult;
    }

    // Recompute summary after each item so the file stays consistent on interruption
    const questionnaireIndexed = await detectQuestionnaireIndexed(projectDir);
    assessment.summary = computeSummary(assessment.items, questionnaireIndexed);
    await writeJson(assessmentPath, assessment);

    // Audit individual item
    const itemAudit = {
      type: "generation_completed" as const,
      timestamp: new Date().toISOString(),
      target: "essential-items" as const,
      section_or_table: `item_${item.code}`,
      prompt_version: PROMPT_VERSION,
      model: lastModel,
      provider: lastProvider,
      input_tokens: result.inputTokens,
      output_tokens: result.outputTokens,
      cost_usd: result.costUsd,
      wall_time_ms: wallMs,
      ...(parseFailed && { parse_failed: true }),
    };
    await appendAuditEvent(projectDir, itemAudit as unknown as AuditEvent);

    onProgress?.(itemIndex, item.code, !parseFailed);
  }

  // ── 4. Final aggregate audit event (only when assessing all 23) ───────────
  if (!itemCode) {
    const aggregateEvent = {
      type: "generation_completed" as const,
      timestamp: new Date().toISOString(),
      target: "essential-items" as const,
      section_or_table: "all_items",
      prompt_version: PROMPT_VERSION,
      model: lastModel,
      provider: lastProvider,
      input_tokens: totalInputTokens,
      output_tokens: totalOutputTokens,
      cost_usd: totalCostUsd,
      wall_time_ms: Date.now() - wallStart,
    };
    await appendAuditEvent(projectDir, aggregateEvent as unknown as AuditEvent);
  }
}
