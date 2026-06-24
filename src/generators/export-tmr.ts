/**
 * TMR XLSX export generator.
 *
 * Reads drafts/tmr/_cells.json and src/concepts/wca-2020.json, then produces
 * a formatted Excel workbook with one sheet "TMR_Results" containing WCA 2020
 * sub-tables 1–23 in order.
 *
 * Layout per sub-table:
 *   • Bold merged title row:   T<n> — <title>
 *   • Merged universe row:     Universe: <universe>
 *   • Grey column-header row:  Row | Col1 (unit) | Col2 (unit) | …
 *   • One data row per WCA row label (numeric values as numbers, missing-value
 *     codes as strings, right-aligned numbers)
 *   • Single row "— not yet generated" when sub-table absent from _cells.json
 *   • Blank separator row
 *
 * Output: exports/<country_iso3>-tmr-<YYYY-MM-DD>.xlsx
 *
 * export async function exportTmr(projectDir: string): Promise<string>
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";
import type * as XLSXTypes from "xlsx";
import type { Manifest } from "../project/schema";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// Production-mode resource root (see tmr.ts for details).
// Injected by the Rust export_project command when running from a bundle.
const RESOURCE_ROOT = process.env["AGCENSUS_RESOURCE_ROOT"] ?? null;

/** WCA 2020 concept registry — same JSON consumed by tmr.ts. */
const WCA_PATH = RESOURCE_ROOT
  ? path.join(RESOURCE_ROOT, "concepts", "wca-2020.json")
  : path.resolve(__dirname, "..", "concepts", "wca-2020.json");

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ColumnSpec {
  unit: string;
  type: "integer" | "decimal";
}

interface SubTableSpec {
  title: string;
  universe: string;
  rows: string[];
  columns: Record<string, ColumnSpec>;
}

interface WcaConcepts {
  sub_tables: Record<string, SubTableSpec>;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

/**
 * Cell key builder — mirrors toCellKey in tmr.ts exactly.
 * Row spaces → underscores; trailing column unit-suffix stripped, then spaces → underscores.
 */
function toCellKey(rowLabel: string, colLabel: string): string {
  const cleanCol = colLabel.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return `${rowLabel.replace(/\s+/g, "_")}_${cleanCol.replace(/\s+/g, "_")}`;
}

/** Non-cell meta-keys that live alongside cell data in a sub-table entry. */
const NON_CELL_KEYS = new Set([
  "validation_flags",
  "parse_failed",
  "truncated",
  "raw_response",
]);

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function exportTmr(projectDir: string): Promise<string> {
  // ── Read inputs ──────────────────────────────────────────────────────────
  const manifest = await readJson<Manifest>(path.join(projectDir, "manifest.json"));
  const wca = await readJson<WcaConcepts>(WCA_PATH);

  let cellsJson: Record<string, unknown> = {};
  try {
    cellsJson = await readJson<Record<string, unknown>>(
      path.join(projectDir, "drafts", "tmr", "_cells.json"),
    );
  } catch {
    // _cells.json absent — every sub-table will be marked "not yet generated"
  }

  // xlsx is CommonJS and calls require() internally; dynamic import defers
  // its initialisation until after the entry script has installed the
  // globalThis.require shim (createRequire), preventing a bundle-time crash.
  const xlsxMod = await import("xlsx");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XLSX = ((xlsxMod as any).default ?? xlsxMod) as typeof xlsxMod;

  // ── Build sheet data ─────────────────────────────────────────────────────
  const wb = XLSX.utils.book_new();

  type CellValue = string | number | null;
  const wsData: CellValue[][] = [];
  const merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [];

  // Deferred style sets (applied after XLSX.utils.aoa_to_sheet)
  const boldSet = new Set<string>();
  const graySet = new Set<string>();
  const rightSet = new Set<string>();

  let rowIdx = 0;

  for (let n = 1; n <= 23; n++) {
    const spec = wca.sub_tables[String(n)];
    if (!spec) continue;

    const colKeys = Object.keys(spec.columns);
    const numCols = colKeys.length + 1; // +1 for the row-label column A
    const subTableKey = `sub_table_${n}`;

    // ── Title row: T<n> — <title> ────────────────────────────────────────
    const titleRow: CellValue[] = [`T${n} — ${spec.title}`];
    for (let c = 1; c < numCols; c++) titleRow.push(null);
    wsData.push(titleRow);
    if (numCols > 1) {
      merges.push({ s: { r: rowIdx, c: 0 }, e: { r: rowIdx, c: numCols - 1 } });
    }
    boldSet.add(XLSX.utils.encode_cell({ r: rowIdx, c: 0 }));
    rowIdx++;

    // ── Universe row ──────────────────────────────────────────────────────
    const univRow: CellValue[] = [`Universe: ${spec.universe}`];
    for (let c = 1; c < numCols; c++) univRow.push(null);
    wsData.push(univRow);
    if (numCols > 1) {
      merges.push({ s: { r: rowIdx, c: 0 }, e: { r: rowIdx, c: numCols - 1 } });
    }
    rowIdx++;

    // ── Column header row: Row | Col1 (unit) | … ─────────────────────────
    const colHeaderRow: CellValue[] = ["Row"];
    for (const col of colKeys) {
      colHeaderRow.push(`${col} (${spec.columns[col].unit})`);
    }
    wsData.push(colHeaderRow);
    for (let c = 0; c < numCols; c++) {
      const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
      boldSet.add(addr);
      graySet.add(addr);
    }
    rowIdx++;

    // ── Data rows ─────────────────────────────────────────────────────────
    const subTableEntry = cellsJson[subTableKey];

    if (!subTableEntry || typeof subTableEntry !== "object") {
      // Sub-table has not been generated yet
      const notGenRow: CellValue[] = ["— not yet generated"];
      for (let c = 1; c < numCols; c++) notGenRow.push(null);
      wsData.push(notGenRow);
      if (numCols > 1) {
        merges.push({ s: { r: rowIdx, c: 0 }, e: { r: rowIdx, c: numCols - 1 } });
      }
      rowIdx++;
    } else {
      const entry = subTableEntry as Record<string, unknown>;
      for (const rowLabel of spec.rows) {
        const dataRow: CellValue[] = [rowLabel];
        for (let ci = 0; ci < colKeys.length; ci++) {
          const key = toCellKey(rowLabel, colKeys[ci]);
          if (NON_CELL_KEYS.has(key)) {
            dataRow.push(null);
            continue;
          }
          const cellObj = entry[key];
          let val: CellValue = null;
          if (
            cellObj !== null &&
            typeof cellObj === "object" &&
            "value" in (cellObj as Record<string, unknown>)
          ) {
            const raw = (cellObj as { value: number | string | null }).value;
            if (typeof raw === "number") {
              val = raw;
              // Mark numeric cells for right-alignment
              rightSet.add(XLSX.utils.encode_cell({ r: rowIdx, c: ci + 1 }));
            } else if (typeof raw === "string") {
              val = raw; // missing-value code, "0", etc.
            }
          }
          dataRow.push(val);
        }
        wsData.push(dataRow);
        rowIdx++;
      }
    }

    // ── Blank separator row ───────────────────────────────────────────────
    wsData.push(Array<CellValue>(numCols).fill(null));
    rowIdx++;
  }

  // ── Convert AOA to XLSX worksheet ────────────────────────────────────────
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!merges"] = merges;

  // ── Apply cell styles ─────────────────────────────────────────────────────
  // SheetJS Community Edition (xlsx 0.18.x): styles via cell.s property.
  for (const addr of boldSet) {
    const cell = ws[addr] as XLSXTypes.CellObject | undefined;
    if (!cell) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cell as any).s = { ...((cell as any).s ?? {}), font: { bold: true } };
  }
  for (const addr of graySet) {
    const cell = ws[addr] as XLSXTypes.CellObject | undefined;
    if (!cell) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cell as any).s = {
      ...((cell as any).s ?? {}),
      fill: { patternType: "solid", fgColor: { rgb: "E8E8E8" } },
    };
  }
  for (const addr of rightSet) {
    const cell = ws[addr] as XLSXTypes.CellObject | undefined;
    if (!cell) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cell as any).s = {
      ...((cell as any).s ?? {}),
      alignment: { horizontal: "right" },
    };
  }

  XLSX.utils.book_append_sheet(wb, ws, "TMR_Results");

  // ── Write output file ─────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const outputDir = path.join(projectDir, "exports");
  await mkdir(outputDir, { recursive: true });
  const filename = `${manifest.country_iso3.toLowerCase()}-tmr-${today}.xlsx`;
  const outputPath = path.join(outputDir, filename);

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  await writeFile(outputPath, buf);

  return outputPath;
}
