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

/**
 * Path to the WCA 2020 concept registry.
 * Resolved as: <src/generators/../concepts/wca-2020.json>
 *            = <project-root>/src/concepts/wca-2020.json
 */
const WCA_CONCEPTS_PATH = path.resolve(
  __dirname,
  "..",
  "concepts",
  "wca-2020.json",
);

/** Acres to hectares conversion factor (exact). */
const ACRES_TO_HA = 0.4047;

/** maxTokens for all sub-table generation calls (default). */
const MAX_TOKENS = 1024;

/**
 * Per-sub-table maxTokens overrides.
 * Sub-tables 3 (Holdings by parcels) and 17 (Irrigation source) hit the 1024
 * limit in Session 10 runs, causing JSON truncation. Raised to 1500.
 */
const SUB_TABLE_MAX_TOKENS: Record<number, number> = {
  3: 1500,
  8: 1500,
  17: 1500,
};

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
 * Step 2: find the outermost { } pair, discarding any preamble text or
 *         partial thinking content that Kimi K2.6 sometimes emits before the JSON.
 *
 * Returns the extracted JSON string, or null if no valid { } pair was found.
 */
function extractJson(text: string): string | null {
  // Step 1: strip markdown fences
  let s = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // Step 2: find the outermost { } pair
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
  // 15 pages — some censuses spread a topic across multiple pages.
  // mode 'tmr' adds numerical-density scoring so number-heavy pages surface
  // even when keyword match fails (non-English census tables).
  const pages = await retrieveEvidence(projectDir, keywords, 15, "tmr");
  const evidenceTables = await retrieveEvidenceTables(projectDir, keywords);

  // Non-English / low-confidence detection: if any retrieved page is low
  // extraction confidence (< 0.8) or was returned as keyword-independent
  // fallback evidence, instruct the model to read numbers positionally.
  const nonEnglishHint = pages.some(
    (p) => (p.extraction_confidence ?? 1) < 0.8 || p.fallback === true,
  );

  // ── 3. Determine generation strategy ─────────────────────────────────────
  const isMultiRow = MULTI_ROW_SUBTABLES.has(subTableNumber);
  const isHouseholdSector = HOUSEHOLD_SECTOR_SUBTABLES.has(subTableNumber);
  // For multi-row: iterate every spec row.  For single-call: null sentinel.
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

  for (const singleRow of rowsToProcess) {
    // Cells to populate on this call: all cells (single-call) or this row's cells
    const cellsForThisCall = singleRow
      ? buildRowCellKeys(spec, singleRow)
      : expectedCellKeys;

    const systemPrompt = buildSystemPrompt();
    const userPrompt = buildUserPrompt(
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
    let parsed: ModelSubTableResponse | null = null;
    try {
      if (!extracted) throw new Error("No JSON object found in response");
      parsed = JSON.parse(extracted) as ModelSubTableResponse;
      if (!parsed.cells || typeof parsed.cells !== "object") {
        throw new Error("Response JSON missing 'cells' object");
      }
    } catch {
      anyParseFailed = true;
      continue; // skip this row/call but continue with others
    }

    // Verify sources and accumulate cells
    for (const [cellKey, modelCell] of Object.entries(parsed.cells)) {
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
      raw_response: "(all row calls failed to parse)",
      validation_flags: [],
    };
    await writeJson(cellsJsonPath, cellsJson);
  } else {
    // ── 6. Fill missing expected keys ─────────────────────────────────────
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
    const validationFlags: ValidationFlag[] = [];
    for (const rule of spec.validation_rules) {
      for (const colLabel of Object.keys(spec.columns)) {
        const flag = runValidationRule(storedCells, rule, colLabel);
        if (flag) validationFlags.push(flag);
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
