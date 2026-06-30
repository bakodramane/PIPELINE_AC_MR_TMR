/**
 * WCA 2020 Essential Items coverage assessment — XLSX export.
 *
 * Reads drafts/essential-items/_assessment.json and produces a formatted
 * Excel workbook with:
 *   Sheet "Essential_Items" — one row per WCA essential item (23 rows)
 *   Columns: WCA item number, WCA item name, WCA definition (short),
 *            Collection status, Questionnaire section, Question number(s),
 *            Evidence from questionnaire, Explanation of match, Confidence, Notes
 *   Below the table: a summary block
 *
 * Output: exports/<iso3>-essential-items-<YYYY-MM-DD>.xlsx
 *
 * export async function exportEssentialItems(projectDir: string): Promise<string>
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

const RESOURCE_ROOT = process.env["AGCENSUS_RESOURCE_ROOT"] ?? null;

const WCA_ESSENTIAL_ITEMS_PATH = RESOURCE_ROOT
  ? path.join(RESOURCE_ROOT, "concepts", "wca-essential-items.json")
  : path.resolve(__dirname, "..", "concepts", "wca-essential-items.json");

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface EssentialItemDefinition {
  code: string;
  name: string;
  theme: string;
  short_description: string;
  is_new: boolean;
}

interface EssentialItemResult {
  code: string;
  name: string;
  theme: string;
  is_new: boolean;
  status: "collected" | "partial" | "not_collected" | "unclear";
  questionnaire_section: string;
  question_numbers: string[];
  evidence_excerpt: string;
  explanation: string;
  confidence: "high" | "medium" | "low";
  notes: string;
  source_pages: string[];
}

interface AssessmentSummary {
  collected: number;
  partial: number;
  not_collected: number;
  unclear: number;
  total_assessed: number;
  headline: string;
  questionnaire_indexed: boolean;
  generated_at: string;
}

interface AssessmentJson {
  items: Record<string, EssentialItemResult>;
  summary: AssessmentSummary;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

const STATUS_LABELS: Record<string, string> = {
  collected: "Collected",
  partial: "Partial",
  not_collected: "Not collected",
  unclear: "Unclear",
};

const CONFIDENCE_LABELS: Record<string, string> = {
  high: "High",
  medium: "Medium",
  low: "Low",
};

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

export async function exportEssentialItems(projectDir: string): Promise<string> {
  // ── Read inputs ──────────────────────────────────────────────────────────
  const manifest = await readJson<Manifest>(path.join(projectDir, "manifest.json"));
  const allItems = await readJson<EssentialItemDefinition[]>(WCA_ESSENTIAL_ITEMS_PATH);

  let assessment: AssessmentJson = { items: {}, summary: {} as AssessmentSummary };
  try {
    assessment = await readJson<AssessmentJson>(
      path.join(projectDir, "drafts", "essential-items", "_assessment.json"),
    );
  } catch {
    // _assessment.json absent — export empty worksheet
  }

  // ── Initialise XLSX ──────────────────────────────────────────────────────
  const xlsxMod = await import("xlsx");
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  const XLSX = ((xlsxMod as any).default ?? xlsxMod) as typeof xlsxMod;

  const wb = XLSX.utils.book_new();
  type CellValue = string | number | null;
  const wsData: CellValue[][] = [];
  const merges: Array<{ s: { r: number; c: number }; e: { r: number; c: number } }> = [];
  const boldSet = new Set<string>();
  const graySet = new Set<string>();

  let rowIdx = 0;
  const NUM_COLS = 10;

  // ── Column headers ────────────────────────────────────────────────────────
  const headers: CellValue[] = [
    "WCA Item Code",
    "WCA Item Name",
    "WCA Definition (short)",
    "Collection status",
    "Questionnaire section",
    "Question number(s)",
    "Evidence from questionnaire",
    "Explanation of match",
    "Confidence",
    "Notes",
  ];
  wsData.push(headers);
  for (let c = 0; c < NUM_COLS; c++) {
    const addr = XLSX.utils.encode_cell({ r: rowIdx, c });
    boldSet.add(addr);
    graySet.add(addr);
  }
  rowIdx++;

  // ── Data rows — one per item ──────────────────────────────────────────────
  for (const item of allItems) {
    const result = assessment.items[item.code];
    const row: CellValue[] = [
      item.code,
      item.name,
      item.short_description,
      result ? (STATUS_LABELS[result.status] ?? result.status) : "Not assessed",
      result?.questionnaire_section ?? "",
      result ? result.question_numbers.join(", ") : "",
      result?.evidence_excerpt ?? "",
      result?.explanation ?? "",
      result ? (CONFIDENCE_LABELS[result.confidence] ?? result.confidence) : "",
      result?.notes ?? "",
    ];
    wsData.push(row);
    rowIdx++;
  }

  // ── Blank separator row ──────────────────────────────────────────────────
  wsData.push(Array<CellValue>(NUM_COLS).fill(null));
  rowIdx++;

  // ── Summary block ─────────────────────────────────────────────────────────
  const summaryTitle: CellValue[] = ["Summary", ...Array<CellValue>(NUM_COLS - 1).fill(null)];
  wsData.push(summaryTitle);
  merges.push({ s: { r: rowIdx, c: 0 }, e: { r: rowIdx, c: NUM_COLS - 1 } });
  boldSet.add(XLSX.utils.encode_cell({ r: rowIdx, c: 0 }));
  rowIdx++;

  const sum = assessment.summary;

  const summaryRows: Array<[string, string | number]> = [
    ["Country", manifest.country],
    ["Census round", manifest.census_round],
    ["Reference year", manifest.reference_year],
    ["Total assessed", sum.total_assessed ?? allItems.length],
    ["Collected", sum.collected ?? 0],
    ["Partial", sum.partial ?? 0],
    ["Not collected", sum.not_collected ?? 0],
    ["Unclear", sum.unclear ?? 0],
    ["Questionnaire indexed", sum.questionnaire_indexed ? "Yes" : "No"],
    ["Generated at", sum.generated_at ?? ""],
  ];

  for (const [label, value] of summaryRows) {
    const row: CellValue[] = [label, String(value), ...Array<CellValue>(NUM_COLS - 2).fill(null)];
    wsData.push(row);
    boldSet.add(XLSX.utils.encode_cell({ r: rowIdx, c: 0 }));
    rowIdx++;
  }

  // ── Build worksheet ───────────────────────────────────────────────────────
  const ws = XLSX.utils.aoa_to_sheet(wsData);
  ws["!merges"] = merges;

  // Column widths (approximate)
  ws["!cols"] = [
    { wch: 14 },  // WCA Item Code
    { wch: 45 },  // WCA Item Name
    { wch: 55 },  // WCA Definition
    { wch: 16 },  // Collection status
    { wch: 24 },  // Questionnaire section
    { wch: 18 },  // Question number(s)
    { wch: 40 },  // Evidence excerpt
    { wch: 50 },  // Explanation
    { wch: 12 },  // Confidence
    { wch: 40 },  // Notes
  ];

  // Apply bold styles
  for (const addr of boldSet) {
    const cell = ws[addr] as XLSXTypes.CellObject | undefined;
    if (!cell) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cell as any).s = { ...((cell as any).s ?? {}), font: { bold: true } };
  }

  // Apply grey header background
  for (const addr of graySet) {
    const cell = ws[addr] as XLSXTypes.CellObject | undefined;
    if (!cell) continue;
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    (cell as any).s = {
      ...((cell as any).s ?? {}),
      fill: { patternType: "solid", fgColor: { rgb: "E8E8E8" } },
    };
  }

  XLSX.utils.book_append_sheet(wb, ws, "Essential_Items");

  // ── Write output ──────────────────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);
  const outputDir = path.join(projectDir, "exports");
  await mkdir(outputDir, { recursive: true });
  const filename = `${manifest.country_iso3.toLowerCase()}-essential-items-${today}.xlsx`;
  const outputPath = path.join(outputDir, filename);

  const buf = XLSX.write(wb, { type: "buffer", bookType: "xlsx" }) as Buffer;
  await writeFile(outputPath, buf);

  return outputPath;
}
