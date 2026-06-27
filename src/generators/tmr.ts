/**
 * TMR (Tables of Main Results) sub-table generator.
 *
 * Exports `generateSubTable(projectDir, subTableNumber, model)`.
 *
 * For each sub-table the generator:
 *   1. Loads the WCA 2020 concept spec from src/concepts/wca-2020.json.
 *   2. Retrieves relevant evidence pages (keyword search) and evidence tables
 *      (full-text scan of evidence/tables/*.json).
 *   3. Calls generate() with the assembled prompt — once per sub-table for
 *      sub-tables with ≤8 rows, or once per row for sub-tables with >8 rows
 *      (see MULTI_ROW_SUBTABLES).
 *   4. Strips markdown fences and parses the JSON response.
 *   5. Verifies every cited source_table_id exists on disk; marks unverified
 *      cells with unverified_source: true (never drops the cell).
 *   6. Applies unit conversions in code (acres → ha); never asks the model
 *      to do arithmetic.
 *   7. Runs validation rules (sum_to_total); records failures in
 *      validation_flags on the sub-table object.
 *   8. Writes populated cells to drafts/tmr/_cells.json under sub_table_<N>.
 *   9. Appends a single generation_completed audit event (aggregates token
 *      counts across all row calls for multi-row sub-tables).
 *
 * On JSON parse failure: writes a parse_failed marker to _cells.json,
 * appends the audit event with parse_failed: true, and returns — never throws.
 *
 * Multi-row generation (MULTI_ROW_SUBTABLES):
 *   Sub-tables 4, 5, 7, 9, 13, 22, and 23 have more than 8 rows.  Sending
 *   all rows in a single prompt causes the model to lose track of which row
 *   it is populating, leading to transposed values and hallucinations.  For
 *   these sub-tables the generator loops over spec.rows and makes one API
 *   call per row.  Results are merged into a single _cells.json entry.
 *
 *   Sub-table 13 (livestock by type) is especially prone to row-alignment
 *   errors because the livestock type names are visually similar (Cattle /
 *   Buffaloes / Yak) and the Head column values span many orders of
 *   magnitude.  One-call-per-row is the only reliable defence.
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

// Production-mode resource root (see mr.ts for details)
const RESOURCE_ROOT = process.env["AGCENSUS_RESOURCE_ROOT"] ?? null;

/**
 * Path to the WCA 2020 concept registry.
 * Dev:  <src/generators/../concepts/wca-2020.json> = <project-root>/src/concepts/wca-2020.json
 * Prod: <RESOURCE_ROOT>/concepts/wca-2020.json
 */
const WCA_CONCEPTS_PATH = RESOURCE_ROOT
  ? path.join(RESOURCE_ROOT, "concepts", "wca-2020.json")
  : path.resolve(__dirname, "..", "concepts", "wca-2020.json");

/** Acres to hectares conversion factor (exact). */
const ACRES_TO_HA = 0.4047;

/**
 * Default maxTokens for all sub-table generation calls.
 * Raised from 1024 → 4096 to cover thinking-model overhead on DeepSeek V4 Pro
 * and Kimi K2.6-thinking.  The actual JSON payload for one sub-table is only
 * 300–500 tokens; the extra headroom is consumed by reasoning traces on
 * thinking models and costs negligibly more at DeepSeek flash pricing.
 */
const MAX_TOKENS = 4096;

/**
 * Per-sub-table maxTokens overrides.
 * All formerly-problematic sub-tables (3, 8, 17) are now at 4096 — same as
 * the default.  Kept explicit so the rationale is visible in code review.
 */
const SUB_TABLE_MAX_TOKENS: Record<number, number> = {
  3: 4096,
  8: 4096,
  17: 4096,
};

/**
 * Maximum evidence pages sent per sub-table generation call.
 *
 * WHY 5: Mongolia pilot showed that 15 pages produced 27,000+ input tokens
 * per call.  For MULTI_ROW sub-tables (4, 5, 7, 9, 13, 22, 23) the same
 * pages are included in every row-level call, so ST-9 (48 rows) consumed
 * 655,343 input tokens — roughly $2 at Claude Sonnet 4.6 pricing.
 * Reducing to the 5 most-relevant pages cuts per-call evidence to ~9,000
 * tokens and reduces multi-row totals by 3x.
 */
const MAX_EVIDENCE_PAGES_PER_CALL = 5;

/**
 * Hard ceiling on the total evidence page text (characters) sent per call.
 * ~32,000 chars ≈ 8,000 tokens.  Pages are sorted most-relevant-first so the
 * best evidence is never truncated.
 */
const MAX_EVIDENCE_CHARS = 32_000;

/**
 * Maximum evidence tables sent per sub-table generation call.
 * Keeps the tables section proportional to the page reduction.
 */
const MAX_EVIDENCE_TABLES_PER_CALL = 5;

/**
 * Evidence retrieval keywords per sub-table number.
 * Exported so the smoke test can verify entries exist for all supported
 * sub-table numbers without making any API calls.
 */
export const SUBTABLE_KEYWORDS: Record<number, string[]> = {
  1: [
    "holdings",
    "legal status",
    "civil",
    "juridical",
    "total holdings",
    "area",
  ],
  2: [
    "tenure",
    "owner",
    "tenant",
    "rented",
    "legal ownership",
  ],
  3: [
    "parcel",
    "fragmentation",
    "plot",
    "land fragment",
  ],
  4: [
    "size class",
    "farm size",
    "size distribution",
    "hectares",
    "land area",
  ],
  5: [
    "land use",
    "arable",
    "temporary crops",
    "permanent crops",
    "pastures",
    "fallow",
  ],
  6: [
    "purpose",
    "sale",
    "consumption",
    "market",
    "household production",
  ],
  7: [
    "household members",
    "household",
    "age",
    "male",
    "female",
    "agricultural activities",
  ],
  8: [
    "holder",
    "sex",
    "male holder",
    "female holder",
    "co-holder",
    "joint holder",
  ],
  9: [
    "holder age",
    "age group",
    "years",
    "male",
    "female",
  ],
  10: [
    "household size",
    "household members",
    "persons",
    "family size",
  ],
  11: [
    "manager",
    "employee",
    "worker",
    "hired labour",
    "labor",
    "paid worker",
  ],
  12: [
    "livestock system",
    "grazing",
    "mixed system",
    "industrial",
    "livestock holdings",
  ],
  13: [
    "livestock",
    "cattle",
    "buffalo",
    "sheep",
    "goats",
    "poultry",
    "chicken",
    "head",
  ],
  14: [
    "irrigated",
    "irrigation",
    "irrigated land",
    "land actually irrigated",
    "fully controlled",
    "partially controlled",
  ],
  15: [
    "irrigation method",
    "surface irrigation",
    "sprinkler",
    "localized irrigation",
    "drip",
  ],
  16: [
    "irrigation land use",
    "irrigated crops",
    "irrigated pastures",
    "temporary crops irrigated",
    "permanent crops irrigated",
  ],
  17: [
    "irrigation source",
    "canal",
    "tubewell",
    "pump",
    "spring",
    "water source",
  ],
  18: [
    "machinery",
    "tractor",
    "combine harvester",
    "plough",
    "equipment used",
    "agricultural machinery",
  ],
  19: [
    "machinery owned",
    "tractor",
    "combine harvester",
    "plough",
    "equipment owned",
    "belonging to holding",
  ],
  20: [
    "pesticide",
    "insecticide",
    "herbicide",
    "fungicide",
    "rodenticide",
    "crop protection",
  ],
  21: [
    "fertilizer",
    "mineral fertilizer",
    "organic fertilizer",
    "manure",
    "biofertilizer",
    "soil amendment",
  ],
  22: [
    "temporary crops",
    "cereals",
    "wheat",
    "rice",
    "maize",
    "vegetables",
    "harvested area",
  ],
  23: [
    "permanent crops",
    "orchard",
    "fruit",
    "citrus",
    "vineyard",
    "beverage crops",
    "spice crops",
  ],
};

/**
 * Sub-tables that require one model call per row to avoid row-alignment errors.
 * These sub-tables have more than 8 rows; sending all rows in a single prompt
 * causes the model to lose track of which row it is populating.
 *
 * Sub-table 13 (livestock by type, 22 rows) is especially critical: the
 * livestock names are visually similar and Head values vary by orders of
 * magnitude, making transposition almost certain in a single-call prompt.
 * Sub-tables 22 (temporary crops, 15 rows) and 23 (permanent crops, 11 rows)
 * also require row-per-call discipline.
 *
 * Exported so the offline smoke test can assert the set is correct without
 * making any API calls.
 */
export const MULTI_ROW_SUBTABLES = new Set([4, 5, 7, 9, 13, 22, 23]);

/**
 * Sub-tables that cover the household sector only.
 * A note is added to the user prompt to remind the model of this constraint.
 */
const HOUSEHOLD_SECTOR_SUBTABLES = new Set([6, 7, 8, 9, 10]);

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
  /** Maximum acceptable delta between sum and total (default: 1). */
  tolerance?: number;
}

interface SubTableSpec {
  title: string;
  universe: string;
  rows: string[];
  columns: Record<string, ColumnSpec>;
  validation_rules: ValidationRule[];
  missing_value_codes: Record<string, string>;
  /**
   * When true, this sub-table's rows are bins of a single variable (e.g. land
   * size classes, household size).  If the source reports DIFFERENT bins than
   * the WCA defaults, the generator uses the source's bins as the row labels
   * instead of forcing the WCA categories and leaving them empty.  Only set on
   * sub-tables whose rows are arbitrary bins of one variable — never on
   * sub-tables with fixed structural rows (legal status, livestock types).
   */
  adaptive_categories?: boolean;
  /** Human-readable name of the binned variable, for the adaptive prompt. */
  category_variable?: string;
  /**
   * Structural rows that are always kept regardless of source bins (e.g.
   * "Total").  Everything else in `rows` is a replaceable WCA-default bin.
   */
  fixed_rows?: string[];
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

/** The model's full response for one sub-table (or one row). */
interface ModelSubTableResponse {
  sub_table: number;
  cells: Record<string, ModelCellEntry>;
}

/** One row in an adaptive-category response: a source-derived category label
 *  plus its cell values keyed by the exact column labels. */
interface AdaptiveRowEntry {
  category: string;
  cells: Record<string, ModelCellEntry>;
}

/** The model's response for an adaptive-category sub-table.  The row labels
 *  (`rows[].category`) come from the source when they differ from the WCA
 *  defaults, so they are returned explicitly rather than pre-supplied. */
interface AdaptiveModelResponse {
  sub_table: number;
  rows: AdaptiveRowEntry[];
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
 * Robust JSON extraction.
 *
 * Step 1: strip markdown fences (handles ```json ... ``` and ``` ... ``` variants).
 * Step 2: strip thinking-model tag blocks that some Kimi K2.6 deployments emit
 *         inside the content field even when thinking is "disabled":
 *           <think>…</think>  <thinking>…</thinking>  <reasoning>…</reasoning>
 * Step 3: find the outermost { } pair, discarding any remaining preamble text.
 *
 * Returns the extracted JSON string, or null if no valid { } pair was found.
 */
function extractJson(text: string): string | null {
  // Step 1: strip markdown fences
  let s = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // Step 2: strip thinking/reasoning tag blocks
  // Use non-greedy match so nested content is handled correctly.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
  s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').trim();

  // Step 3: find the outermost { } pair
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  return s.slice(start, end + 1);
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
 * Build cell keys for a single row across all columns.
 * Used for one-row-per-call generation in multi-row sub-tables.
 */
function buildRowCellKeys(spec: SubTableSpec, rowLabel: string): string[] {
  return Object.keys(spec.columns).map((col) => toCellKey(rowLabel, col));
}

/**
 * Compare two row-label lists as case-insensitive sets (order-independent).
 * Used to decide whether an adaptive sub-table's categories actually differ
 * from the WCA defaults.
 */
function rowListsEqual(a: string[], b: string[]): boolean {
  if (a.length !== b.length) return false;
  const setB = new Set(b.map((s) => s.trim().toLowerCase()));
  return a.every((v) => setB.has(v.trim().toLowerCase()));
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
 * Format evidence pages for the prompt, with a hard character ceiling.
 *
 * Pages are included in relevance order (most relevant first).  When the
 * combined text exceeds MAX_EVIDENCE_CHARS the block is truncated at that
 * boundary so the most relevant pages are never cut.
 */
function formatEvidencePageBlock(pages: PageJson[]): string {
  if (pages.length === 0) {
    return "(No matching evidence pages found.)";
  }
  const blocks = pages.map(
    (p) => `[Page ${p.page_id}, p.${p.page_number}]\n${p.text}`,
  );
  let combined = blocks.join("\n\n---\n\n");
  if (combined.length > MAX_EVIDENCE_CHARS) {
    combined =
      combined.slice(0, MAX_EVIDENCE_CHARS) +
      "\n\n[… evidence truncated at cost-control ceiling …]";
  }
  return combined;
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

/**
 * Build the user prompt for one sub-table generation call.
 *
 * @param subTableNumber    The sub-table number.
 * @param spec              The WCA 2020 sub-table specification.
 * @param pages             Relevant evidence pages.
 * @param tables            Relevant evidence tables.
 * @param cellsToPopulate   Cell keys to ask the model to populate (may be a
 *                          subset of all keys when singleRow is set).
 * @param singleRow         When set, the model populates only this one row.
 *                          Used for multi-row sub-tables (MULTI_ROW_SUBTABLES).
 * @param isHouseholdSector When true, adds a household-sector-only note to the
 *                          prompt (for sub-tables 6–10).
 */
function buildUserPrompt(
  subTableNumber: number,
  spec: SubTableSpec,
  pages: PageJson[],
  tables: TableJson[],
  cellsToPopulate: string[],
  singleRow?: string,
  isHouseholdSector?: boolean,
  nonEnglishHint?: boolean,
): string {
  // Build cell key → (row, col) description, filtered to cellsToPopulate
  const cellDescriptions: string[] = [];
  const cellKeySet = new Set(cellsToPopulate);
  for (const rowLabel of spec.rows) {
    for (const colLabel of Object.keys(spec.columns)) {
      const key = toCellKey(rowLabel, colLabel);
      if (cellKeySet.has(key)) {
        const colSpec = spec.columns[colLabel];
        cellDescriptions.push(
          `  "${key}": row="${rowLabel}", column="${colLabel}", expected unit="${colSpec.unit}"`,
        );
      }
    }
  }

  // Optional banners
  const singleRowBanner = singleRow
    ? `\n\n**ONE ROW ONLY:** This call populates a single row. Provide data ONLY for the row: "${singleRow}". Do not populate any other rows.`
    : "";

  const householdSectorNote = isHouseholdSector
    ? `\n\nUniverse note: This sub-table covers the **household sector only**. Only include holdings operated by civil persons or groups of civil persons (i.e. individual farm households).`
    : "";

  const nonEnglishNote = nonEnglishHint
    ? `\n\nThe source document may be in a non-English language. Look for numeric values in the evidence pages that correspond to the row labels by their position in tables, not by matching English keywords. Return the numeric values you find even if the surrounding text is not in English.`
    : "";

  return `## Sub-Table Specification${singleRowBanner}${nonEnglishNote}

Sub-Table ${subTableNumber}: ${spec.title}
Universe: ${spec.universe}${householdSectorNote}

Rows: ${spec.rows.join(" | ")}
Columns: ${Object.entries(spec.columns)
    .map(([col, s]) => `${col} (unit: ${s.unit})`)
    .join(" | ")}

## Required Cells

Populate exactly these ${cellsToPopulate.length} cells (key = row_column, spaces as underscores, parenthetical unit suffixes stripped):

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
${cellDescriptions.map((d) => `    ${d.trim().split(":")[0]}: { ... }`).join(",\n")}
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

Provide all ${cellsToPopulate.length} cells.`;
}

/**
 * Build the user prompt for an adaptive-category sub-table.
 *
 * Unlike buildUserPrompt, this does NOT lock the model to the WCA row labels.
 * It tells the model the standard WCA categories but instructs it to use the
 * source's own categories when the source bins the variable differently,
 * preserving the source's labels.  The model returns a `rows` array of
 * { category, cells } so the actual category labels survive into _cells.json.
 */
function buildAdaptiveUserPrompt(
  subTableNumber: number,
  spec: SubTableSpec,
  pages: PageJson[],
  tables: TableJson[],
  isHouseholdSector?: boolean,
  nonEnglishHint?: boolean,
): string {
  const variable = spec.category_variable ?? "this variable";
  const fixedRows = spec.fixed_rows ?? [];
  const wcaBins = spec.rows.filter((r) => !fixedRows.includes(r));

  const columnLines = Object.entries(spec.columns)
    .map(([col, s]) => `  "${col}" (expected unit: ${s.unit})`)
    .join("\n");

  const householdSectorNote = isHouseholdSector
    ? `\n\nUniverse note: This sub-table covers the **household sector only**. Only include holdings operated by civil persons or groups of civil persons (i.e. individual farm households).`
    : "";

  const nonEnglishNote = nonEnglishHint
    ? `\n\nThe source document may be in a non-English language. Read numeric values positionally from the tables; the category labels you return should be a faithful (translated if necessary) rendering of the source's own bins.`
    : "";

  const fixedRowsNote = fixedRows.length
    ? `\n\nAlways include ${fixedRows.map((r) => `"${r}"`).join(", ")} as ${fixedRows.length > 1 ? "rows" : "a row"}.`
    : "";

  return `## Sub-Table Specification (adaptive categories)${nonEnglishNote}

Sub-Table ${subTableNumber}: ${spec.title}
Universe: ${spec.universe}${householdSectorNote}

This sub-table breaks down holdings by **${variable}**.

The standard WCA 2020 categories for ${variable} are:
${wcaBins.map((b) => `  - ${b}`).join("\n")}

**Adaptive category rule:**
- If the source document reports these EXACT categories, use them as the row labels.
- If the source reports DIFFERENT categories for ${variable} (e.g. different size bins or ranges, such as "1–5 / 6–8 / 9 and more" instead of the standard bins), use the categories **AS REPORTED in the source** — preserve the source's actual labels verbatim as the row labels.
- Do NOT force the source data into the standard categories.
- Do NOT invent categories that are not present in the source.
- Keep the same value columns (listed below) unchanged.${fixedRowsNote}

Columns (use these EXACT column labels as keys in each row's "cells" object):
${columnLines}

## Evidence Pages (PRIMARY SOURCE — search here first)

Census reports frequently present aggregate totals in introductory text sections before the formal tables. READ EACH PAGE CAREFULLY. Extract numeric values from sentences, paragraphs, and table-like structures in the text.

${formatEvidencePageBlock(pages)}

## Evidence Tables (SUPPLEMENTARY — cross-reference when available)

${formatEvidenceTableBlock(tables)}

## Output Instructions

Return ONLY a valid JSON object — no markdown fences, no preamble. Exact structure:

{
  "sub_table": ${subTableNumber},
  "rows": [
    {
      "category": "<row label — the source's own category, or the WCA standard label if they match>",
      "cells": {
${Object.keys(spec.columns)
  .map((col) => `        "${col}": { "value": <number or "..">, "unit": "<unit>", "source_table_id": "<table_id or page_id>", "source_row": "<row label in source>", "source_column": "<column header>", "derived": false, "derivation": null }`)
  .join(",\n")}
      }
    }
  ]
}

Rules:
- Never invent, estimate, or calculate values — copy them directly from the source as written.
- Do NOT perform unit conversions. Report the value and unit as they appear; the application converts in code.
- If a value cannot be found, set it to the WCA missing-value code ".." and source_table_id to "".
- Source ID rules: a structured table → use its table_id (e.g. "01-main-report-t003"); page text only → use the page_id (e.g. "01-main-report-p0026").
- Return one entry in "rows" for EACH category the source actually reports.`;
}

// ---------------------------------------------------------------------------
// Source verification
// ---------------------------------------------------------------------------

/**
 * Check whether a source ID (table_id or page_id) exists on disk.
 * Returns true when:
 *   - sourceId is empty (no source required — legitimately missing value)
 *   - The file exists in evidence/tables/ or evidence/pages/
 * Returns false only when sourceId is non-empty AND not found in either directory.
 */
async function verifySource(
  sourceId: string,
  tablesDir: string,
  pagesDir: string,
): Promise<boolean> {
  const id = (sourceId ?? "").trim();
  if (!id) return true; // empty source = legitimate "not available"
  try {
    await access(path.join(tablesDir, `${id}.json`));
    return true;
  } catch {
    try {
      await access(path.join(pagesDir, `${id}.json`));
      return true;
    } catch {
      return false;
    }
  }
}

// ---------------------------------------------------------------------------
// Validation
// ---------------------------------------------------------------------------

/**
 * Run one sum_to_total validation rule for one column.
 * Returns a ValidationFlag if the rule fails (delta > tolerance), null if it
 * passes or cannot be evaluated (missing numeric values).
 */
function runValidationRule(
  cells: Record<string, TmrCell>,
  rule: ValidationRule,
  colLabel: string,
): ValidationFlag | null {
  const tolerance = rule.tolerance ?? 1;
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
  if (delta > tolerance) {
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
 * Sub-tables with ≤8 rows (e.g. 1, 2, 3, 6, 8, 10, 11) use a single model
 * call.  Sub-tables with >8 rows (4, 5, 7, 9) use one call per row to prevent
 * the model from transposing or hallucinating values across rows.
 *
 * @param projectDir      Absolute path to the country project directory.
 * @param subTableNumber  The sub-table number to generate (currently 1–11).
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

  // ── 2. Retrieve evidence (shared across all row calls) ────────────────────
  const keywords = SUBTABLE_KEYWORDS[subTableNumber] ?? [];
  // Use MAX_EVIDENCE_PAGES_PER_CALL (5) instead of 15.  For single-call
  // sub-tables this saves ~18,000 tokens per call.  For MULTI_ROW sub-tables
  // the same pages are re-sent on every row call, so the saving multiplies by
  // the row count (up to 48× for ST-9).  The 5 most-relevant pages by score
  // are always the best evidence; extra pages add noise more than signal.
  const pages = await retrieveEvidence(
    projectDir, keywords, MAX_EVIDENCE_PAGES_PER_CALL, "tmr",
  );
  const evidenceTables = await retrieveEvidenceTables(
    projectDir, keywords, MAX_EVIDENCE_TABLES_PER_CALL,
  );

  // Non-English / low-confidence detection: if any retrieved page is low
  // extraction confidence (< 0.8) or was returned as keyword-independent
  // fallback evidence, instruct the model to read numbers positionally.
  const nonEnglishHint = pages.some(
    (p) => (p.extraction_confidence ?? 1) < 0.8 || p.fallback === true,
  );

  // ── 3. Determine generation strategy ─────────────────────────────────────
  const isAdaptive = spec.adaptive_categories === true;
  // Adaptive sub-tables always run as a SINGLE call: the row categories are not
  // known until the model reads the source (they may be the source's own bins
  // rather than the WCA defaults), so one-call-per-row is impossible.
  const isMultiRow = !isAdaptive && MULTI_ROW_SUBTABLES.has(subTableNumber);
  const isHouseholdSector = HOUSEHOLD_SECTOR_SUBTABLES.has(subTableNumber);
  // For multi-row: iterate every spec row.  For single-call/adaptive: null sentinel.
  const rowsToProcess: Array<string | null> = isMultiRow ? spec.rows : [null];

  // ── 4. Generate cells ─────────────────────────────────────────────────────
  const storedCells: Record<string, TmrCell> = {};
  const tablesDir = path.join(projectDir, "evidence", "tables");
  const pagesDir = path.join(projectDir, "evidence", "pages");

  let anyParseFailed = false;
  let anyTruncated = false;
  let wallTotal = 0;
  let inputTokensTotal = 0;
  let outputTokensTotal = 0;
  let costUsdTotal = 0;
  let lastModel: Model = model;
  let lastProvider = "";
  // Capture the raw model text from the most recent failed parse so it can
  // be stored as raw_preview in _cells.json for debugging without opening files.
  let lastRawResponse = "";
  // Adaptive sub-tables only: the row category labels the model actually used
  // (the source's bins when they differ from the WCA defaults).
  let usedCategories: string[] | null = null;

  // Store one model cell under its canonical key (shared by the fixed-row and
  // adaptive-category paths so verification + shape stay identical).
  const storeCell = async (
    cellKey: string,
    modelCell: ModelCellEntry,
  ): Promise<void> => {
    const sourceId = (modelCell.source_table_id ?? "").trim();
    const sourceVerified = await verifySource(sourceId, tablesDir, pagesDir);
    const value = parseModelValue(modelCell.value);

    storedCells[cellKey] = {
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
  };

  for (const singleRow of rowsToProcess) {
    // Cells to populate on this call: all cells (single-call) or this row's cells
    const cellsForThisCall = singleRow
      ? buildRowCellKeys(spec, singleRow)
      : expectedCellKeys;

    const systemPrompt = buildSystemPrompt();
    const userPrompt = isAdaptive
      ? buildAdaptiveUserPrompt(
          subTableNumber,
          spec,
          pages,
          evidenceTables,
          isHouseholdSector,
          nonEnglishHint,
        )
      : buildUserPrompt(
          subTableNumber,
          spec,
          pages,
          evidenceTables,
          cellsForThisCall,
          singleRow ?? undefined,
          isHouseholdSector,
          nonEnglishHint,
        );

    const wallStart = Date.now();
    // Per-model max-token safety check: Kimi K2.6 tends to be more verbose,
    // so multiply the budget by 1.5 to reduce truncation failures. Cap at 4096.
    const baseMaxTokens = SUB_TABLE_MAX_TOKENS[subTableNumber] ?? MAX_TOKENS;
    const effectiveMaxTokens =
      model === "kimi-k2.6" || model === "kimi-k2.6-thinking"
        ? Math.min(Math.round(baseMaxTokens * 1.5), 4096)
        : baseMaxTokens;
    const result = await generate({
      systemPrompt,
      userPrompt,
      model,
      maxTokens: effectiveMaxTokens,
      // temperature=0 for data extraction: deterministic responses reduce the
      // risk of the model hallucinating or omitting values across runs.
      temperature: 0,
      // Disable thinking for TMR: data extraction just needs to find a number
      // and return JSON.  Reasoning traces consume token budget without
      // improving accuracy, and can cause truncation on V4 Pro.
      disableThinking: true,
    });
    wallTotal += Date.now() - wallStart;
    inputTokensTotal += result.inputTokens;
    outputTokensTotal += result.outputTokens;
    costUsdTotal += result.costUsd;
    lastModel = result.model;
    lastProvider = result.provider;
    if (result.finishReason === 'length') anyTruncated = true;

    // Parse response — use extractJson to tolerate preamble text or partial
    // thinking content that some models (notably Kimi K2.6) emit before the JSON.
    const extracted = extractJson(result.text);

    if (isAdaptive) {
      // Adaptive path: rows carry source-derived category labels.
      let parsedA: AdaptiveModelResponse | null = null;
      try {
        if (!extracted) throw new Error("No JSON object found in response");
        parsedA = JSON.parse(extracted) as AdaptiveModelResponse;
        if (!Array.isArray(parsedA.rows)) {
          throw new Error("Adaptive response JSON missing 'rows' array");
        }
      } catch {
        anyParseFailed = true;
        lastRawResponse = result.text; // preserve for raw_preview in _cells.json
        continue;
      }

      const cats: string[] = [];
      for (const rowEntry of parsedA.rows) {
        const category = String(rowEntry?.category ?? "").trim();
        if (!category || !rowEntry.cells || typeof rowEntry.cells !== "object") {
          continue;
        }
        cats.push(category);
        for (const [colLabel, modelCell] of Object.entries(rowEntry.cells)) {
          await storeCell(toCellKey(category, colLabel), modelCell);
        }
      }
      usedCategories = cats;
    } else {
      // Fixed-row path: cells keyed directly by the WCA row_column convention.
      let parsed: ModelSubTableResponse | null = null;
      try {
        if (!extracted) throw new Error("No JSON object found in response");
        parsed = JSON.parse(extracted) as ModelSubTableResponse;
        if (!parsed.cells || typeof parsed.cells !== "object") {
          throw new Error("Response JSON missing 'cells' object");
        }
      } catch {
        anyParseFailed = true;
        lastRawResponse = result.text; // preserve for raw_preview in _cells.json
        continue; // skip this row/call but continue with others
      }

      // Verify sources and accumulate cells
      for (const [cellKey, modelCell] of Object.entries(parsed.cells)) {
        await storeCell(cellKey, modelCell);
      }
    }
  }

  // ── 5. Paths ──────────────────────────────────────────────────────────────
  const cellsJsonPath = path.join(projectDir, "drafts", "tmr", "_cells.json");
  const subTableKey = `sub_table_${subTableNumber}`;

  // Complete failure — no cells at all
  if (anyParseFailed && Object.keys(storedCells).length === 0) {
    let cellsJson: Record<string, unknown> = {};
    try {
      cellsJson = await readJson<Record<string, unknown>>(cellsJsonPath);
    } catch {
      // start fresh
    }
    cellsJson[subTableKey] = {
      parse_failed: true,
      ...(anyTruncated && { truncated: true }),
      raw_preview: lastRawResponse.slice(0, 200),
      error: "JSON parse failed",
      validation_flags: [],
    };
    await writeJson(cellsJsonPath, cellsJson);
  } else {
    // Final row labels: source-derived categories for adaptive sub-tables when
    // the model returned any, else the WCA defaults.  categoriesAdapted is true
    // only when those categories actually differ from the WCA standard.
    const finalRows =
      isAdaptive && usedCategories && usedCategories.length > 0
        ? usedCategories
        : spec.rows;
    const categoriesAdapted =
      isAdaptive && !rowListsEqual(finalRows, spec.rows);

    // ── 6. Fill missing expected keys ─────────────────────────────────────
    // For adaptive sub-tables, "expected" means the categories the source
    // actually used; for fixed-row sub-tables it is the WCA row × column grid.
    const keysToEnsure = isAdaptive
      ? finalRows.flatMap((rowLabel) =>
          Object.keys(spec.columns).map((col) => toCellKey(rowLabel, col)),
        )
      : expectedCellKeys;
    for (const key of keysToEnsure) {
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

    // ── 7. Apply unit conversions ─────────────────────────────────────────
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

    // ── 8. Run validation rules ───────────────────────────────────────────
    // The WCA sum_to_total rules reference the WCA default row labels.  When
    // the categories were adapted to the source's own bins those labels no
    // longer exist, so the rules are not applicable — skip them.
    const validationFlags: ValidationFlag[] = [];
    if (!categoriesAdapted) {
      for (const rule of spec.validation_rules) {
        for (const colLabel of Object.keys(spec.columns)) {
          const flag = runValidationRule(storedCells, rule, colLabel);
          if (flag) validationFlags.push(flag);
        }
      }
    }

    // ── 9. Write to _cells.json ───────────────────────────────────────────
    let cellsJson: Record<string, unknown> = {};
    try {
      cellsJson = await readJson<Record<string, unknown>>(cellsJsonPath);
    } catch {
      // start fresh
    }
    cellsJson[subTableKey] = {
      ...storedCells,
      validation_flags: validationFlags,
      // Traceability: record when the rows are the source's own categories
      // rather than the WCA standard, plus both lists so a reviewer (and the
      // draft export) can see exactly what changed.
      ...(isAdaptive && {
        categories_adapted: categoriesAdapted,
        used_categories: finalRows,
        wca_default_categories: spec.rows,
      }),
      ...(anyParseFailed && { parse_failed: true }),
      ...(anyTruncated && { truncated: true }),
    };
    await writeJson(cellsJsonPath, cellsJson);
  }

  // ── 10. Append audit event (one per sub-table; token counts aggregated) ───
  const event = {
    type: "generation_completed" as const,
    timestamp: new Date().toISOString(),
    target: "tmr" as const,
    section_or_table: subTableKey,
    prompt_version: PROMPT_VERSION,
    model: lastModel,
    provider: lastProvider,
    input_tokens: inputTokensTotal,
    output_tokens: outputTokensTotal,
    cost_usd: costUsdTotal,
    wall_time_ms: wallTotal,
    ...(anyParseFailed && { parse_failed: true }),
    ...(anyTruncated && { truncated: true }),
  };
  await appendAuditEvent(projectDir, event as unknown as AuditEvent);
}
