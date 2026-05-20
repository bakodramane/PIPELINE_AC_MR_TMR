/**
 * TMR (Tables of Main Results) sub-table generator.
 *
 * Exports `generateSubTable(projectDir, subTableNumber, model)`.
 *
 * For each sub-table the generator:
 *   1. Loads the WCA 2020 concept spec from src/concepts/wca-2020.json.
 *   2. Retrieves relevant evidence pages (keyword search) and evidence tables
 *      (full-text scan of evidence/tables/*.json).
 *   3. Calls generate() with the assembled prompt.
 *   4. Strips markdown fences and parses the JSON response.
 *   5. Verifies every cited source_table_id exists on disk; marks unverified
 *      cells with unverified_source: true (never drops the cell).
 *   6. Applies unit conversions in code (acres → ha); never asks the model
 *      to do arithmetic.
 *   7. Runs validation rules (sum_to_total); records failures in
 *      validation_flags on the sub-table object.
 *   8. Writes populated cells to drafts/tmr/_cells.json under sub_table_<N>.
 *   9. Appends a generation_completed audit event.
 *
 * On JSON parse failure: writes a parse_failed marker to _cells.json,
 * appends the audit event with parse_failed: true, and returns — never throws.
 *
 * Design constraint (from Session Sequence document):
 *   Sub-table 1 has only 4 rows — a single model call is fine.
 *   For sub-tables with 10+ rows (livestock, crops), future generators
 *   MUST populate one row per model call.  Do not implement multi-row
 *   generation here; that belongs in the Session 8+ generators.
 *
 * Unit conversions:
 *   - 1 acre = 0.4047 ha  (exact factor stored in ACRES_TO_HA)
 *   Conversion is recorded in the cell: conversion: "acres to ha: ..."
 *
 * Constraints:
 *  - All paths use path.join() — no hardcoded separators.
 *  - All file I/O uses fs/promises — no sync calls.
 */

import { readFile, writeFile, access, readdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generate } from "../providers/index";
import type { Model } from "../providers/types";
import { retrieveEvidence } from "./evidence";
import { appendAuditEvent } from "../project/io";
import type { AuditEvent, PageJson, TableJson } from "../project/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Prompt version baked into every audit event. */
const PROMPT_VERSION = "v1.3";

/**
 * Path to the WCA 2020 concept registry.
 * Resolved as: <src/generators/../concepts/wca-2020.json>
 *            = <worktree-root>/src/concepts/wca-2020.json
 */
const WCA_CONCEPTS_PATH = path.resolve(
  __dirname,
  "..",
  "concepts",
  "wca-2020.json",
);

/** Acres to hectares conversion factor (exact). */
const ACRES_TO_HA = 0.4047;

/** maxTokens for all sub-table generation calls. */
const MAX_TOKENS = 1024;

/** Evidence retrieval keywords per sub-table number. */
const SUBTABLE_KEYWORDS: Record<number, string[]> = {
  1: [
    "holdings",
    "legal status",
    "civil",
    "juridical",
    "total holdings",
    "area",
  ],
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ColumnSpec {
  unit: string;
  type: "integer" | "decimal";
}

interface ValidationRule {
  rule: "sum_to_total";
  description: string;
  rows: string[];
  total_row: string;
}

interface SubTableSpec {
  title: string;
  universe: string;
  rows: string[];
  columns: Record<string, ColumnSpec>;
  validation_rules: ValidationRule[];
  missing_value_codes: Record<string, string>;
}

interface WcaConcepts {
  sub_tables: Record<string, SubTableSpec>;
}

/** One cell as returned by the model. */
interface ModelCellEntry {
  value: number | string;
  unit: string;
  source_table_id: string;
  source_row: string;
  source_column: string;
  derived: boolean;
  derivation: string | null;
}

/** The model's full response for one sub-table. */
interface ModelSubTableResponse {
  sub_table: number;
  cells: Record<string, ModelCellEntry>;
}

/** One stored cell in _cells.json (extends schema.Cell with TMR fields). */
interface TmrCell {
  value: number | string | null;
  unit: string;
  sources: Array<{ table_id: string; row: string; column: string }>;
  derived: boolean;
  derivation: string | null;
  flags: string[];
  human_edited: boolean;
  unverified_source?: boolean;
  conversion?: string;
}

/** One recorded failure from a validation rule. */
interface ValidationFlag {
  rule: string;
  column: string;
  expected: number;
  actual: number;
  delta: number;
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

/**
 * Strip markdown code fences that some models add even when instructed not to.
 */
function stripFences(raw: string): string {
  return raw
    .replace(/^```(?:json)?\s*\n?/m, "")
    .replace(/\n?\s*```\s*$/m, "")
    .trim();
}

/**
 * Build the canonical cell key from row and column labels.
 * Convention: "<rowLabel>_<colLabel>" with:
 *   - spaces → underscores
 *   - trailing parenthetical unit suffixes stripped from the column label
 *     (e.g. "Area (ha)" → "Area", so the key is "Total_Area" not "Total_Area_(ha)")
 */
function toCellKey(rowLabel: string, colLabel: string): string {
  const cleanCol = colLabel.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return `${rowLabel.replace(/\s+/g, "_")}_${cleanCol.replace(/\s+/g, "_")}`;
}

/**
 * Build the list of all expected cell keys for a sub-table spec,
 * in row-major order (all columns for row 1, then row 2, etc.).
 */
function buildExpectedCellKeys(spec: SubTableSpec): string[] {
  const keys: string[] = [];
  for (const rowLabel of spec.rows) {
    for (const colLabel of Object.keys(spec.columns)) {
      keys.push(toCellKey(rowLabel, colLabel));
    }
  }
  return keys;
}

/**
 * Parse a raw model value into a number or a WCA missing-value code string.
 * Handles comma-formatted numbers ("4,130,789" → 4130789).
 */
function parseModelValue(v: unknown): number | string {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (typeof v === "string") {
    const cleaned = v.replace(/,/g, "").trim();
    const n = parseFloat(cleaned);
    if (Number.isFinite(n)) return n;
    // Valid WCA missing-value codes
    if (["...", "..", "0", "*", "c"].includes(v.trim())) return v.trim();
    return ".."; // unknown string → treat as "not available"
  }
  return ".."; // null / undefined / other → not available
}

// ---------------------------------------------------------------------------
// Evidence retrieval — tables
// ---------------------------------------------------------------------------

/**
 * Retrieve relevant TableJson objects from evidence/tables/.
 *
 * Reads every table file in the directory, scores each by keyword overlap
 * on title + column headers + row labels, and returns the top N by score.
 * Falls back to returning the first N tables when no keyword scores at all.
 *
 * @param projectDir  Absolute path to the country project directory.
 * @param keywords    Query terms (case-insensitive substring matching).
 * @param maxTables   Maximum number of tables to return (default 15).
 */
async function retrieveEvidenceTables(
  projectDir: string,
  keywords: string[],
  maxTables = 15,
): Promise<TableJson[]> {
  const tablesDir = path.join(projectDir, "evidence", "tables");
  let tableFiles: string[];
  try {
    const entries = await readdir(tablesDir);
    tableFiles = entries.filter((f) => f.endsWith(".json"));
  } catch {
    return []; // no tables directory
  }

  const normalizedKeywords = keywords.map((k) => k.toLowerCase());
  const scored: { table: TableJson; score: number }[] = [];

  for (const filename of tableFiles) {
    const tablePath = path.join(tablesDir, filename);
    let table: TableJson;
    try {
      table = await readJson<TableJson>(tablePath);
    } catch {
      continue;
    }

    // Searchable text: title + column headers + row labels
    const searchableText = [
      table.title,
      ...table.columns,
      ...table.rows.map((r) => r.label),
    ]
      .join(" ")
      .toLowerCase();

    let score = 0;
    for (const kw of normalizedKeywords) {
      if (searchableText.includes(kw)) score += 1;
      if (table.title.toLowerCase().includes(kw)) score += 1; // title bonus
    }

    scored.push({ table, score });
  }

  // Sort by score descending, stable by table_id
  scored.sort((a, b) =>
    b.score !== a.score
      ? b.score - a.score
      : a.table.table_id.localeCompare(b.table.table_id),
  );

  const hasPositive = scored.some((s) => s.score > 0);
  const toReturn = hasPositive
    ? scored.filter((s) => s.score > 0).slice(0, maxTables)
    : scored.slice(0, maxTables);

  return toReturn.map((s) => s.table);
}

// ---------------------------------------------------------------------------
// Evidence formatting
// ---------------------------------------------------------------------------

/**
 * Format evidence pages for the prompt.
 */
function formatEvidencePageBlock(pages: PageJson[]): string {
  if (pages.length === 0) {
    return "(No matching evidence pages found.)";
  }
  return pages
    .map((p) => `[Page ${p.page_id}, p.${p.page_number}]\n${p.text}`)
    .join("\n\n---\n\n");
}

/**
 * Format evidence tables for the prompt.
 * Uses a plain-text grid with | separators so the model can read values.
 */
function formatEvidenceTableBlock(tables: TableJson[]): string {
  if (tables.length === 0) {
    return "(No matching evidence tables found.)";
  }
  return tables
    .map((t) => {
      const header = t.columns.join(" | ");
      const separator = t.columns.map(() => "---").join(" | ");
      const rows = t.rows
        .map((r) => {
          const vals = r.values.map((v) => (v === null ? "—" : String(v)));
          return `${r.label} | ${vals.join(" | ")}`;
        })
        .join("\n");
      return (
        `[Table ${t.table_id}, p.${t.page_number}]\n` +
        `Title: ${t.title}\n` +
        `${header}\n${separator}\n${rows}`
      );
    })
    .join("\n\n---\n\n");
}

// ---------------------------------------------------------------------------
// Prompt construction
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  return `You are a data extraction assistant for FAO's World Census of Agriculture 2020 project.

Your task: extract specific numeric cell values from agricultural census source tables and return them as structured JSON.

Rules:
1. Locate each requested cell value in the provided evidence tables. Use the evidence pages for context if a table is unclear.
2. Use the EXACT table_id shown in each evidence table's header line (e.g. "01-main-report-t003").
3. Never invent, estimate, or calculate values — copy them directly from the source table as written.
4. Do NOT perform unit conversions. If the source reports area in acres, return the acres value and set unit to "acres". The application converts units in code.
5. If a value cannot be found in the evidence, set it to the WCA missing-value code ".." (not available).
6. Return ONLY valid JSON — no markdown code fences, no explanatory text before or after the JSON.`;
}

function buildUserPrompt(
  subTableNumber: number,
  spec: SubTableSpec,
  pages: PageJson[],
  tables: TableJson[],
  expectedCellKeys: string[],
): string {
  // Build cell key → (row, col) description for the prompt
  const cellDescriptions: string[] = [];
  for (const rowLabel of spec.rows) {
    for (const colLabel of Object.keys(spec.columns)) {
      const key = toCellKey(rowLabel, colLabel);
      const colSpec = spec.columns[colLabel];
      cellDescriptions.push(
        `  "${key}": row="${rowLabel}", column="${colLabel}", expected unit="${colSpec.unit}"`,
      );
    }
  }

  return `## Sub-Table Specification

Sub-Table ${subTableNumber}: ${spec.title}
Universe: ${spec.universe}

Rows: ${spec.rows.join(" | ")}
Columns: ${Object.entries(spec.columns)
    .map(([col, s]) => `${col} (unit: ${s.unit})`)
    .join(" | ")}

## Required Cells

Populate exactly these ${expectedCellKeys.length} cells (key = row_column, spaces as underscores, parenthetical unit suffixes stripped):

${cellDescriptions.join("\n")}

## Evidence Pages (PRIMARY SOURCE — search here first)

Census reports frequently present aggregate totals in introductory text sections before the formal tables. READ EACH PAGE CAREFULLY. Extract numeric values from sentences, paragraphs, and table-like structures in the text.

${formatEvidencePageBlock(pages)}

## Evidence Tables (SUPPLEMENTARY — cross-reference when available)

${formatEvidenceTableBlock(tables)}

## Output Instructions

IMPORTANT: For "Total" row values, look for summary sentences such as "there are a total of X holdings" or "X hectares of agricultural land". These numbers appear in page text even when no structured table exists for this sub-table.

Only return ".." for a cell after reading ALL pages above and confirming the value is genuinely absent.

Return ONLY a valid JSON object — no markdown fences, no preamble. Exact structure:

{
  "sub_table": ${subTableNumber},
  "cells": {
${cellDescriptions.map(d => `    ${d.trim().split(":")[0]}: { ... }`).join(",\n")}
  }
}

Each cell entry must be:

{
  "value": <number copied exactly from the source, or ".." if truly not found>,
  "unit": "<unit string as it appears in the source>",
  "source_table_id": "<source ID — either a table_id from an evidence table header OR a page_id from an evidence page header>",
  "source_row": "<row label or descriptive phrase locating the value>",
  "source_column": "<column header or field name>",
  "derived": false,
  "derivation": null
}

Source ID rules:
- Found in a structured table → use the table_id (e.g. "01-main-report-t003")
- Found in page text only → use the page_id (e.g. "01-main-report-p0026")
- Genuinely not found anywhere → set value to ".." and source_table_id to ""

Provide all ${expectedCellKeys.length} cells.`;
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Run one sum_to_total validation rule for one column.
 * Returns a ValidationFlag if the rule fails (delta > 1), null if it passes
 * or cannot be evaluated (missing numeric values).
 */
function runValidationRule(
  cells: Record<string, TmrCell>,
  rule: ValidationRule,
  colLabel: string,
): ValidationFlag | null {
  const totalKey = toCellKey(rule.total_row, colLabel);
  const totalCell = cells[totalKey];
  if (!totalCell || typeof totalCell.value !== "number") return null;

  let sum = 0;
  for (const rowLabel of rule.rows) {
    const key = toCellKey(rowLabel, colLabel);
    const cell = cells[key];
    if (!cell || typeof cell.value !== "number") return null; // incomplete — skip
    sum += cell.value;
  }

  const delta = Math.abs(sum - totalCell.value);
  if (delta > 1) {
    return {
      rule: rule.rule,
      column: colLabel,
      expected: totalCell.value,
      actual: sum,
      delta,
    };
  }

  return null; // passed
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate one TMR sub-table and persist results to the project directory.
 *
 * @param projectDir      Absolute path to the country project directory.
 * @param subTableNumber  The sub-table number to generate (currently 1–26).
 * @param model           The model to use for generation.
 */
export async function generateSubTable(
  projectDir: string,
  subTableNumber: number,
  model: Model,
): Promise<void> {
  // ── 0. Load WCA 2020 concepts ─────────────────────────────────────────────
  const concepts = await readJson<WcaConcepts>(WCA_CONCEPTS_PATH);
  const spec = concepts.sub_tables[String(subTableNumber)];

  if (!spec) {
    console.warn(
      `[tmr.ts] No WCA 2020 spec for sub-table ${subTableNumber}. ` +
        `Add it to src/concepts/wca-2020.json and re-run.`,
    );
    return;
  }

  // ── 1. Build expected cell keys ───────────────────────────────────────────
  const expectedCellKeys = buildExpectedCellKeys(spec);

  // ── 2. Retrieve evidence ──────────────────────────────────────────────────
  const keywords = SUBTABLE_KEYWORDS[subTableNumber] ?? [];
  // 15 pages — some censuses spread the legal-status table across multiple pages
  const pages = await retrieveEvidence(projectDir, keywords, 15);
  const evidenceTables = await retrieveEvidenceTables(projectDir, keywords);

  // ── 3. Build prompts ──────────────────────────────────────────────────────
  const systemPrompt = buildSystemPrompt();
  const userPrompt = buildUserPrompt(
    subTableNumber,
    spec,
    pages,
    evidenceTables,
    expectedCellKeys,
  );

  // ── 4. Call the model ─────────────────────────────────────────────────────
  const wallStart = Date.now();
  const result = await generate({
    systemPrompt,
    userPrompt,
    model,
    maxTokens: MAX_TOKENS,
    // temperature=0 for data extraction: deterministic responses reduce the
    // risk of the model hallucinating or omitting values across runs.
    temperature: 0,
  });
  const wallTimeMs = Date.now() - wallStart;

  // ── 5. Parse response ─────────────────────────────────────────────────────
  const stripped = stripFences(result.text);
  let parsed: ModelSubTableResponse | null = null;
  let parseFailed = false;

  try {
    parsed = JSON.parse(stripped) as ModelSubTableResponse;
    if (!parsed.cells || typeof parsed.cells !== "object") {
      throw new Error("Response JSON missing 'cells' object");
    }
  } catch {
    parseFailed = true;
  }

  // ── 6. Paths ──────────────────────────────────────────────────────────────
  const cellsJsonPath = path.join(projectDir, "drafts", "tmr", "_cells.json");
  const subTableKey = `sub_table_${subTableNumber}`;

  if (parseFailed || !parsed) {
    // Graceful fallback — write a parse_failed marker so the UI can surface it
    let cellsJson: Record<string, unknown> = {};
    try {
      cellsJson = await readJson<Record<string, unknown>>(cellsJsonPath);
    } catch {
      // start fresh
    }
    cellsJson[subTableKey] = {
      parse_failed: true,
      raw_response: result.text.slice(0, 500), // truncated for storage
      validation_flags: [],
    };
    await writeJson(cellsJsonPath, cellsJson);
  } else {
    // ── 7. Verify source tables / pages ──────────────────────────────────
    const tablesDir = path.join(projectDir, "evidence", "tables");
    const pagesDir = path.join(projectDir, "evidence", "pages");
    const storedCells: Record<string, TmrCell> = {};

    for (const [cellKey, modelCell] of Object.entries(parsed.cells)) {
      // The source ID can be a table_id (evidence/tables/) or a page_id
      // (evidence/pages/) — census data is sometimes only in prose text,
      // not in a structured table.
      const sourceId = (modelCell.source_table_id ?? "").trim();

      // Verify source exists on disk — but only when the model provided a
      // non-empty source ID.  An empty source_table_id paired with ".."
      // is a legitimate "value not available" response and must NOT be
      // flagged as unverified.
      let sourceVerified = true; // default: no source required
      if (sourceId) {
        sourceVerified = false;
        // Check tables directory first
        try {
          await access(path.join(tablesDir, `${sourceId}.json`));
          sourceVerified = true;
        } catch {
          // Not in tables — check pages directory (census data is sometimes
          // only available as prose text, not in a structured table)
          try {
            await access(path.join(pagesDir, `${sourceId}.json`));
            sourceVerified = true;
          } catch {
            // Source file not found in either location
          }
        }
      }

      const value = parseModelValue(modelCell.value);

      const stored: TmrCell = {
        value,
        unit: (modelCell.unit ?? "").trim() || "unknown",
        sources: [
          {
            table_id: modelCell.source_table_id,
            row: modelCell.source_row,
            column: modelCell.source_column,
          },
        ],
        derived: Boolean(modelCell.derived),
        derivation: modelCell.derivation ?? null,
        flags: [],
        human_edited: false,
        ...(!sourceVerified && { unverified_source: true }),
      };

      storedCells[cellKey] = stored;
    }

    // Populate any expected keys the model missed with ".." (not available)
    for (const key of expectedCellKeys) {
      if (!(key in storedCells)) {
        storedCells[key] = {
          value: "..",
          unit: "",
          sources: [],
          derived: false,
          derivation: null,
          flags: ["model_did_not_populate"],
          human_edited: false,
        };
      }
    }

    // ── 8. Apply unit conversions ─────────────────────────────────────────
    for (const cell of Object.values(storedCells)) {
      if (typeof cell.value !== "number") continue;
      const unitLower = cell.unit.toLowerCase().trim();
      if (unitLower === "acres" || unitLower === "acre") {
        const raw = cell.value;
        const converted = Math.round(raw * ACRES_TO_HA * 100) / 100;
        cell.value = converted;
        cell.unit = "hectares";
        cell.derived = true;
        cell.conversion = `acres to ha: ${raw} * ${ACRES_TO_HA} = ${converted}`;
      }
    }

    // ── 9. Run validation rules ───────────────────────────────────────────
    const validationFlags: ValidationFlag[] = [];
    for (const rule of spec.validation_rules) {
      for (const colLabel of Object.keys(spec.columns)) {
        const flag = runValidationRule(storedCells, rule, colLabel);
        if (flag) validationFlags.push(flag);
      }
    }

    // ── 10. Write to _cells.json ──────────────────────────────────────────
    let cellsJson: Record<string, unknown> = {};
    try {
      cellsJson = await readJson<Record<string, unknown>>(cellsJsonPath);
    } catch {
      // start fresh
    }
    cellsJson[subTableKey] = {
      ...storedCells,
      validation_flags: validationFlags,
    };
    await writeJson(cellsJsonPath, cellsJson);
  }

  // ── 11. Append audit event ────────────────────────────────────────────────
  const event = {
    type: "generation_completed" as const,
    timestamp: new Date().toISOString(),
    target: "tmr" as const,
    section_or_table: subTableKey,
    prompt_version: PROMPT_VERSION,
    model: result.model,
    provider: result.provider,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    cost_usd: result.costUsd,
    wall_time_ms: wallTimeMs,
    ...(parseFailed && { parse_failed: true }),
  };
  await appendAuditEvent(projectDir, event as unknown as AuditEvent);
}
