/**
 * Excel (.xlsx / .xls) → { pages, tables } parser.
 *
 * Uses SheetJS (`xlsx`) to read the workbook. Each sheet becomes:
 *   - one TableJson (structured: first non-empty row = headers, rest = rows)
 *   - one PageJson (text representation: sheet name + all cell values, for
 *     keyword-based evidence retrieval)
 *
 * Excel is already structured data, so extraction_confidence is fixed at 0.95.
 *
 * Constraints:
 *  - All paths use path.join() — no hardcoded separators.
 *  - File I/O uses fs/promises — no sync calls.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PageJson, TableJson, TableRow } from "../project/schema";

// Excel is structured data → high, fixed confidence.
const EXCEL_CONFIDENCE = 0.95;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Slugify a sheet name for use in a stable table_id:
 * lowercase, non-alphanumeric runs → single hyphen, trim leading/trailing.
 */
function slugify(name: string): string {
  return (
    name
      .toLowerCase()
      .replace(/[^a-z0-9]+/g, "-")
      .replace(/^-+|-+$/g, "") || "sheet"
  );
}

/** True when a cell value is non-empty (not null/undefined/blank string). */
function isNonEmpty(v: unknown): boolean {
  return v !== null && v !== undefined && String(v).trim() !== "";
}

/** True when a row (array of cells) has at least one non-empty cell. */
function rowHasContent(row: unknown[]): boolean {
  return Array.isArray(row) && row.some(isNonEmpty);
}

/** Coerce a raw SheetJS cell into the string|number values stored in TableRow. */
function cellToValue(v: unknown): string | number {
  if (typeof v === "number" && Number.isFinite(v)) return v;
  if (v === null || v === undefined) return "";
  return String(v);
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Parse an Excel workbook into evidence pages and tables.
 *
 * @param filePath     Absolute or relative path to the .xlsx / .xls file.
 * @param sourceDocId  The source document id (page/table id prefix + source_doc).
 * @param language     BCP-47 language tag for the document (default "en").
 */
export async function parseExcel(
  filePath: string,
  sourceDocId: string,
  language = "en",
): Promise<{ pages: PageJson[]; tables: TableJson[] }> {
  const absPath = path.resolve(filePath);
  const buffer = await readFile(absPath);

  // xlsx is CommonJS and calls require() internally; dynamic import defers
  // its initialisation until after the entry script has installed the
  // globalThis.require shim (createRequire), preventing a bundle-time crash.
  const xlsxMod = await import("xlsx");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XLSX = ((xlsxMod as any).default ?? xlsxMod) as typeof xlsxMod;

  const workbook = XLSX.read(buffer, { type: "buffer" });

  const pages: PageJson[] = [];
  const tables: TableJson[] = [];

  workbook.SheetNames.forEach((sheetName, idx) => {
    const sheetIndex = idx + 1; // 1-based
    const worksheet = workbook.Sheets[sheetName];

    // Read the sheet as a 2-D array of cells (blank cells → "").
    const matrix: unknown[][] = XLSX.utils.sheet_to_json(worksheet, {
      header: 1,
      defval: "",
      blankrows: false,
    }) as unknown[][];

    // Keep only rows with at least one non-empty cell.
    const nonEmptyRows = matrix.filter(rowHasContent);

    const slug = slugify(sheetName);
    const tableId = `${sourceDocId}-sheet-${sheetIndex}-${slug}`;

    // First non-empty row → headers; remaining → data rows.
    const headerRow = nonEmptyRows.length > 0 ? nonEmptyRows[0] : [];
    const dataRows = nonEmptyRows.slice(1);

    const columns: string[] = headerRow.map((c) => String(cellToValue(c)));

    const rows: TableRow[] = dataRows.map((raw) => {
      const cells = raw.map(cellToValue);
      const label = cells.length > 0 ? String(cells[0]) : "";
      const values = cells.slice(1);
      return { label, values } as unknown as TableRow;
    });

    tables.push({
      table_id: tableId,
      source_doc: sourceDocId,
      page_number: sheetIndex,
      title: sheetName,
      columns,
      rows,
      units: {},
      extraction_confidence: EXCEL_CONFIDENCE,
    });

    // Text representation of the sheet for keyword matching.
    const textLines = nonEmptyRows.map((r) =>
      r
        .map(cellToValue)
        .map((v) => String(v))
        .join(" "),
    );
    const text = [sheetName, ...textLines].join("\n");

    const pageId = `${sourceDocId}-sheet-${sheetIndex}-${slug}`;
    pages.push({
      page_id: pageId,
      source_doc: sourceDocId,
      page_number: sheetIndex,
      text,
      headings: [sheetName],
      tables_on_page: [tableId],
      language,
      extraction_confidence: EXCEL_CONFIDENCE,
    });
  });

  return { pages, tables };
}
