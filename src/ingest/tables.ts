/**
 * Heuristic table extractor.
 *
 * Takes an array of PageJson objects and returns TableJson objects found by
 * pattern-matching on each page's text content.
 *
 * Detection rule (per DESIGN.md §4.3):
 *   Look for lines where values are separated by two or more spaces or a tab,
 *   with a consistent number of columns across three or more consecutive lines.
 *
 * Additional filter: at least one column per candidate row must contain a
 * parseable number, to avoid treating prose paragraphs as table rows.
 *
 * Constraints:
 *  - All paths use path.join() — no hardcoded separators.
 *  - No file I/O here (pure transformation).
 */

import type { PageJson, TableJson, TableRow } from "../project/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Regex that splits a line into columns on 2+ spaces or a tab. */
const COL_SPLIT = /\t| {2,}/;

/**
 * Minimum number of consecutive candidate rows required to declare a table.
 * Using 3 per the design spec.
 */
const MIN_TABLE_ROWS = 3;

/** Minimum number of columns in a detected table row. */
const MIN_COLS = 2;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Split a line into columns using the two-or-more-spaces / tab delimiter.
 * Returns the non-empty trimmed parts.
 */
function splitCols(line: string): string[] {
  return line
    .split(COL_SPLIT)
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

/**
 * Return true if the string looks like a number.
 * Handles: integers, decimals, numbers with commas (1,234), "n.a.", "..", "…"
 */
function isNumericLike(s: string): boolean {
  const cleaned = s.replace(/,/g, "").trim();
  if (/^-?\d+(\.\d+)?$/.test(cleaned)) return true;
  if (/^n\.a\.$|^\.{2,}|^…$/.test(s.trim())) return true;
  return false;
}

/**
 * Return true if at least one column in the split parts looks numeric.
 * (Filters out header-only lines, chapter titles, etc.)
 */
function hasNumericColumn(parts: string[]): boolean {
  return parts.some(isNumericLike);
}

/**
 * Attempt to parse a column value as a number.
 * Removes commas, handles "n.a." / ".." / "…" as null.
 */
function parseValue(s: string): number | null {
  const t = s.trim();
  if (/^n\.a\.$|^\.{2,}|^…$/.test(t)) return null;
  const n = parseFloat(t.replace(/,/g, ""));
  return Number.isFinite(n) ? n : null;
}

/** Compute extraction confidence for a detected table. */
function tableConfidence(rows: string[][]): number {
  let numeric = 0;
  let total = 0;
  for (const row of rows) {
    for (const cell of row.slice(1)) {
      // skip label column
      total++;
      if (isNumericLike(cell)) numeric++;
    }
  }
  if (total === 0) return 0.7;
  return numeric / total >= 0.7 ? 0.85 : 0.7;
}

// ---------------------------------------------------------------------------
// Core table detection
// ---------------------------------------------------------------------------

interface CandidateTable {
  /** The line immediately before the first data row (possible title). */
  title: string;
  /** All rows (first used as header, rest as data). */
  rows: string[][];
  /** 1-based page number this table was found on. */
  pageNumber: number;
}

/**
 * Scan one page's text and return all candidate tables found.
 */
function detectTablesOnPage(
  text: string,
  pageNumber: number,
): CandidateTable[] {
  const lines = text.split("\n");
  const candidates: CandidateTable[] = [];

  let runStart = -1;
  let runCols = 0;
  let prevLine = "";

  const flushRun = (endIdx: number) => {
    const runLength = endIdx - runStart;
    if (runStart >= 0 && runLength >= MIN_TABLE_ROWS) {
      candidates.push({
        title: prevLine,
        rows: lines
          .slice(runStart, endIdx)
          .map(splitCols)
          .filter((r) => r.length > 0),
        pageNumber,
      });
    }
    runStart = -1;
    runCols = 0;
  };

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const parts = splitCols(line);
    const isCandidateRow =
      parts.length >= MIN_COLS && hasNumericColumn(parts);

    if (isCandidateRow) {
      if (runStart === -1) {
        // Start a new run — save the line before this one as a potential title
        prevLine = i > 0 ? (lines[i - 1]?.trim() ?? "") : "";
        runStart = i;
        runCols = parts.length;
      } else if (parts.length === runCols) {
        // Continue the run
      } else {
        // Column count changed — flush and start fresh
        flushRun(i);
        prevLine = lines[i - 1]?.trim() ?? "";
        runStart = i;
        runCols = parts.length;
      }
    } else {
      flushRun(i);
    }
  }
  flushRun(lines.length);

  return candidates;
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Extract tables from an array of PageJson objects.
 *
 * Table IDs are stable within a session: "{sourceDocId}-t{3-digit-global-index}".
 * The `tables_on_page` array on each PageJson is NOT mutated here — that is
 * the pipeline's responsibility.
 *
 * @param pages       Pages from parsePdf(), in order.
 * @param sourceDocId The source document id (used in table_id and source_doc).
 */
export function extractTables(
  pages: PageJson[],
  sourceDocId: string,
): TableJson[] {
  const tables: TableJson[] = [];
  let globalIdx = 1; // 1-based counter for the 3-digit ID field

  for (const page of pages) {
    const candidates = detectTablesOnPage(page.text, page.page_number);

    for (const cand of candidates) {
      if (cand.rows.length < MIN_TABLE_ROWS) continue;

      const id = `${sourceDocId}-t${String(globalIdx).padStart(3, "0")}`;
      globalIdx++;

      // First row → column headers; remaining → data rows
      const headerRow = cand.rows[0];
      const dataRows = cand.rows.slice(1);

      const columns: string[] = headerRow;

      const rows: TableRow[] = dataRows.map((parts) => {
        const label = parts[0] ?? "";
        // Values: columns 1..n, parsed as numbers where possible
        const values: (number | null)[] = parts
          .slice(1)
          .map((p) => parseValue(p));
        // Pad or trim to match the number of value columns in the header
        const expectedValues = Math.max(0, columns.length - 1);
        while (values.length < expectedValues) values.push(null);
        return { label, values: values.slice(0, expectedValues) };
      });

      // Build a units map (empty — units are not determinable from plain text)
      const units: Record<string, string> = {};
      for (const col of columns.slice(1)) {
        if (col) units[col] = "";
      }

      tables.push({
        table_id: id,
        source_doc: sourceDocId,
        page_number: page.page_number,
        title: cand.title || id,
        columns,
        rows,
        units,
        extraction_confidence: tableConfidence(cand.rows),
      });
    }
  }

  return tables;
}
