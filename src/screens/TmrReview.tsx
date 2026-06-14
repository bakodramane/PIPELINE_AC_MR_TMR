/**
 * Screen — TMR sub-table review.
 *
 * Shows all 23 WCA 2020 sub-tables for one country project.
 * Each sub-table is a card with status badge + populated/total cell count;
 * clicking expands it to reveal a row × column grid loaded from
 * drafts/tmr/_cells.json, with validation flags below.
 *
 * Cell key convention (mirrors tmr.ts toCellKey):
 *   "{rowLabel_with_spaces_replaced}_{colLabel_unit_suffix_stripped}"
 *   e.g. row="Total", col="Area (ha)" → "Total_Area"
 *        row="Civil persons", col="Holdings" → "Civil_persons_Holdings"
 *
 * Session 14: "Generate all" and per-subtable "Generate" buttons now call
 * the real Tauri `generate_tmr_subtable` command.  Progress events stream
 * back from Rust and each completed subtable reloads from disk in place.
 */

import { useState, useEffect, useCallback, type FC } from "react";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type {
  ToastMessage,
  SubTableInfo,
  SubTableStatus,
  TmrCellDisplay,
  ValidationFlagDisplay,
} from "../types/ui";
import wcaData from "../concepts/wca-2020.json";
import { MODELS_BY_TIER, DEFAULT_TMR_MODEL, getModelInfo } from "../providers/model-registry";
import type { Model } from "../providers/types";

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

function joinPath(...parts: string[]): string {
  return parts.map((p) => p.replace(/[/\\]+$/, "")).join("/");
}

// ---------------------------------------------------------------------------
// Timestamp formatter — "DD Mon YYYY, HH:MM" in local time
// ---------------------------------------------------------------------------

const MONTH_NAMES = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

function formatLastRun(isoStr: string): string {
  const d = new Date(isoStr);
  const dd   = String(d.getDate()).padStart(2, "0");
  const mon  = MONTH_NAMES[d.getMonth()] ?? "???";
  const yyyy = d.getFullYear();
  const hh   = String(d.getHours()).padStart(2, "0");
  const mm   = String(d.getMinutes()).padStart(2, "0");
  return `${dd} ${mon} ${yyyy}, ${hh}:${mm}`;
}

// ---------------------------------------------------------------------------
// WCA 2020 type helpers
// ---------------------------------------------------------------------------

interface WcaColumnSpec {
  unit: string;
  type: "integer" | "decimal";
}

interface WcaSubTableSpec {
  title: string;
  universe: string;
  rows: readonly string[];
  columns: Record<string, WcaColumnSpec>;
  validation_rules: Array<{
    rule: string;
    description: string;
    rows: readonly string[];
    total_row: string;
    tolerance?: number;
  }>;
  missing_value_codes: Record<string, string>;
}

const WCA_SUBTABLES = wcaData.sub_tables as Record<string, WcaSubTableSpec>;

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface TmrReviewProps {
  projectDir: string;
  projectName: string;
  onBack: () => void;
  onSwitchToMr: () => void;
  onToast: (msg: string, type: ToastMessage["type"]) => void;
}

// ---------------------------------------------------------------------------
// Event payload (mirrors Rust GenerationProgressPayload)
// ---------------------------------------------------------------------------

interface GenerationProgressPayload {
  type: string;   // "mr" | "tmr"
  number: number;
  status: string; // "done" | "error"
  message?: string;
}

// ---------------------------------------------------------------------------
// Cell key helper (mirrors tmr.ts toCellKey exactly)
// ---------------------------------------------------------------------------

function toCellKey(rowLabel: string, colLabel: string): string {
  const cleanCol = colLabel.replace(/\s*\([^)]*\)\s*$/, "").trim();
  return `${rowLabel.replace(/\s+/g, "_")}_${cleanCol.replace(/\s+/g, "_")}`;
}

// ---------------------------------------------------------------------------
// Missing value code descriptions
// ---------------------------------------------------------------------------

const MISSING_VALUE_DESCS: Record<string, string> = {
  "..": "not available",
  "...": "not applicable",
  "…": "not applicable",
  "0": "true reported zero",
  "*": "provisional",
  c: "confidential",
};

function isMissingCode(v: number | string | null): boolean {
  if (v === null) return true;
  if (typeof v === "number") return false;
  return v in MISSING_VALUE_DESCS || v === "";
}

// ---------------------------------------------------------------------------
// Sub-table data loader
// ---------------------------------------------------------------------------

const NON_CELL_KEYS = new Set([
  "validation_flags",
  "parse_failed",
  "truncated",
  "raw_response",
  "raw_preview",
  "error",
]);

function parseSubTableEntry(
  num: number,
  rawEntry: Record<string, unknown>,
  spec: WcaSubTableSpec,
): SubTableInfo {
  const parseFailed = rawEntry.parse_failed === true;
  const truncatedWarning = rawEntry.truncated === true;
  const rawPreview =
    typeof rawEntry.raw_preview === "string" ? rawEntry.raw_preview : undefined;
  const totalCells = spec.rows.length * Object.keys(spec.columns).length;

  const validationFlags: ValidationFlagDisplay[] = Array.isArray(
    rawEntry.validation_flags,
  )
    ? (rawEntry.validation_flags as ValidationFlagDisplay[])
    : [];

  const cells: Record<string, TmrCellDisplay> = {};
  for (const [key, val] of Object.entries(rawEntry)) {
    if (NON_CELL_KEYS.has(key)) continue;
    if (val === null || typeof val !== "object") continue;
    const v = val as Record<string, unknown>;
    if (!("value" in v)) continue;
    cells[key] = {
      value: v.value as number | string | null,
      unit: typeof v.unit === "string" ? v.unit : "",
      derived: Boolean(v.derived),
      flags: Array.isArray(v.flags) ? (v.flags as string[]) : [],
      human_edited: Boolean(v.human_edited),
      ...(v.unverified_source === true && { unverified_source: true }),
      ...(typeof v.conversion === "string" && { conversion: v.conversion }),
    };
  }

  let status: SubTableStatus;
  if (parseFailed && Object.keys(cells).length === 0) {
    status = "parse_failed";
  } else {
    const populatedCells = Object.values(cells).filter(
      (c) => typeof c.value === "number",
    ).length;
    if (populatedCells === 0) {
      status = "empty";
    } else if (populatedCells >= totalCells) {
      status = "populated";
    } else {
      status = "partial";
    }
  }

  const populatedCells = Object.values(cells).filter(
    (c) => typeof c.value === "number",
  ).length;

  return {
    number: num,
    title: spec.title,
    status,
    populatedCells,
    totalCells,
    validationFlags,
    truncatedWarning,
    cells,
    rawPreview,
  };
}

async function loadSubTables(projectDir: string): Promise<SubTableInfo[]> {
  const cellsPath = [projectDir, "drafts", "tmr", "_cells.json"]
    .map((p) => p.replace(/[/\\]+$/, ""))
    .join("/");

  let cellsJson: Record<string, unknown> = {};
  try {
    const raw = await readTextFile(cellsPath);
    cellsJson = JSON.parse(raw) as Record<string, unknown>;
  } catch {
    // File absent — all sub-tables will be "not_generated"
  }

  const result: SubTableInfo[] = [];
  for (let num = 1; num <= 23; num++) {
    const spec = WCA_SUBTABLES[String(num)];
    if (!spec) continue;

    const key = `sub_table_${num}`;
    const rawEntry = cellsJson[key];

    if (!rawEntry || typeof rawEntry !== "object") {
      result.push({
        number: num,
        title: spec.title,
        status: "not_generated",
        populatedCells: 0,
        totalCells: spec.rows.length * Object.keys(spec.columns).length,
        validationFlags: [],
        truncatedWarning: false,
        cells: {},
      });
    } else {
      result.push(
        parseSubTableEntry(num, rawEntry as Record<string, unknown>, spec),
      );
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Status badge
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<
  SubTableStatus,
  { bg: string; text: string; label: string }
> = {
  populated: {
    bg: "bg-green-100 border-green-200",
    text: "text-green-700",
    label: "✓ populated",
  },
  partial: {
    bg: "bg-blue-50 border-blue-200",
    text: "text-blue-700",
    label: "◑ partial",
  },
  empty: {
    bg: "bg-yellow-50 border-yellow-200",
    text: "text-yellow-700",
    label: "○ empty",
  },
  parse_failed: {
    bg: "bg-red-50 border-red-200",
    text: "text-red-700",
    label: "✗ failed",
  },
  not_generated: {
    bg: "bg-gray-100 border-gray-200",
    text: "text-gray-500",
    label: "— not run",
  },
};

function StatusBadge({ status }: { status: SubTableStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex items-center text-[11px] font-medium border px-2 py-0.5 rounded-full ${s.bg} ${s.text}`}
    >
      {s.label}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Cell value display
// ---------------------------------------------------------------------------

function CellValue({ cell }: { cell: TmrCellDisplay | undefined }) {
  if (!cell) {
    return <span className="text-gray-300 text-xs italic">—</span>;
  }

  const { value, derived, unverified_source, conversion } = cell;

  if (value === null) {
    return <span className="text-gray-300 text-xs italic">—</span>;
  }

  if (typeof value === "number") {
    return (
      <span
        className={`text-xs tabular-nums ${
          unverified_source ? "text-orange-600" : "text-gray-800"
        } ${derived ? "italic" : ""}`}
        title={
          derived && conversion
            ? conversion
            : unverified_source
            ? "Source could not be verified on disk"
            : undefined
        }
      >
        {value.toLocaleString()}
        {derived && (
          <span className="ml-0.5 text-[9px] text-blue-400 align-super">d</span>
        )}
        {unverified_source && (
          <span className="ml-0.5 text-[9px] text-orange-400 align-super">?</span>
        )}
      </span>
    );
  }

  const desc = MISSING_VALUE_DESCS[value];
  return (
    <span className="text-gray-400 text-xs italic" title={desc ?? value}>
      {value}
    </span>
  );
}

// ---------------------------------------------------------------------------
// Cell grid (expanded sub-table view)
// ---------------------------------------------------------------------------

function CellGrid({ subTable }: { subTable: SubTableInfo }) {
  const spec = WCA_SUBTABLES[String(subTable.number)];
  if (!spec) return null;

  const colLabels = Object.keys(spec.columns);

  return (
    <div className="overflow-x-auto">
      <table className="w-full text-left border-collapse text-xs">
        <thead>
          <tr className="bg-gray-100">
            <th className="py-2 px-3 font-medium text-gray-600 text-[11px] border-b border-gray-200 min-w-[180px]">
              Row
            </th>
            {colLabels.map((col) => (
              <th
                key={col}
                className="py-2 px-3 font-medium text-gray-600 text-[11px] border-b border-gray-200 text-right whitespace-nowrap"
              >
                {col}
                <div className="text-[9px] text-gray-400 font-normal">
                  {spec.columns[col].unit}
                </div>
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {spec.rows.map((rowLabel, rowIdx) => (
            <tr
              key={rowLabel}
              className={rowIdx % 2 === 0 ? "bg-white" : "bg-gray-50"}
            >
              <td className="py-1.5 px-3 text-gray-700 text-[11px] border-b border-gray-100 font-medium">
                {rowLabel}
              </td>
              {colLabels.map((colLabel) => {
                const cellKey = toCellKey(rowLabel, colLabel);
                const cell = subTable.cells[cellKey];
                const isMissing = !cell || isMissingCode(cell.value);
                return (
                  <td
                    key={colLabel}
                    className={`py-1.5 px-3 border-b border-gray-100 text-right ${
                      cell?.unverified_source
                        ? "border-l-2 border-l-orange-300"
                        : ""
                    }`}
                  >
                    <div className="flex items-center justify-end gap-1">
                      <CellValue cell={cell} />
                      {!isMissing && (
                        <button
                          onClick={() => {
                            /* placeholder */
                          }}
                          className="text-[9px] text-gray-300 hover:text-gray-500 transition-colors"
                          title="Edit cell"
                        >
                          ✎
                        </button>
                      )}
                    </div>
                  </td>
                );
              })}
            </tr>
          ))}
        </tbody>
      </table>

      {/* Validation flags */}
      {subTable.validationFlags.length > 0 && (
        <div className="mt-2 p-3 bg-yellow-50 border border-yellow-200 rounded text-xs">
          <div className="font-medium text-yellow-800 mb-1">
            ⚠ Validation failures
          </div>
          {subTable.validationFlags.map((flag, i) => (
            <div key={i} className="text-yellow-700">
              {flag.rule} · {flag.column}: expected{" "}
              {flag.expected.toLocaleString()}, got{" "}
              {flag.actual.toLocaleString()} (Δ {flag.delta.toLocaleString()})
            </div>
          ))}
        </div>
      )}

      {/* Legend */}
      <div className="mt-2 flex flex-wrap gap-3 text-[10px] text-gray-400 px-1">
        <span>
          <span className="italic">d</span> = derived (unit conversion)
        </span>
        <span>
          <span className="text-orange-400">?</span> = unverified source
        </span>
        <span>
          <span className="italic">..&nbsp;</span>= not available
        </span>
        <span>
          <span className="italic">...&nbsp;</span>= not applicable
        </span>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sub-table card
// ---------------------------------------------------------------------------

function SubTableCard({
  subTable,
  isExpanded,
  isGenerating,
  onToggle,
  onGenerate,
  onToast,
}: {
  subTable: SubTableInfo;
  isExpanded: boolean;
  isGenerating: boolean;
  onToggle: () => void;
  onGenerate: () => void;
  onToast: (msg: string, type: ToastMessage["type"]) => void;
}) {
  const hasContent = subTable.populatedCells > 0;

  return (
    <div
      className={`border rounded-lg overflow-hidden transition-shadow ${
        isExpanded ? "border-blue-400 shadow-sm" : "border-gray-200"
      }`}
    >
      {/* Header row — always visible */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 bg-white hover:bg-gray-50 text-left transition-colors"
      >
        <span className="text-xs font-mono text-gray-400 w-6 shrink-0">
          T{subTable.number}
        </span>
        <span className="flex-1 text-sm font-medium text-gray-800 leading-tight">
          {subTable.title}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {isGenerating && (
            <div
              className="w-3 h-3 border border-blue-400 border-t-transparent rounded-full animate-spin"
              title="Generating…"
            />
          )}
          {subTable.truncatedWarning && (
            <span
              className="text-[10px] text-orange-500"
              title="Model output was truncated"
            >
              ⚠
            </span>
          )}
          {subTable.validationFlags.length > 0 && (
            <span
              className="text-[10px] text-yellow-600 bg-yellow-50 border border-yellow-200 px-1.5 py-0.5 rounded"
              title={`${subTable.validationFlags.length} validation flag(s)`}
            >
              ⚠ {subTable.validationFlags.length}
            </span>
          )}
          {hasContent && (
            <span className="text-xs text-gray-400 tabular-nums">
              {subTable.populatedCells}/{subTable.totalCells}
            </span>
          )}
          <StatusBadge status={subTable.status} />
          <span className="text-gray-300 ml-1">
            {isExpanded ? "▲" : "▼"}
          </span>
        </div>
      </button>

      {/* Expanded body */}
      {isExpanded && (
        <div className="border-t border-gray-100 bg-gray-50 px-4 py-3">
          {WCA_SUBTABLES[String(subTable.number)] && (
            <div className="text-[10px] text-gray-400 mb-3">
              Universe: {WCA_SUBTABLES[String(subTable.number)].universe}
            </div>
          )}

          {subTable.status === "not_generated" ? (
            <p className="text-sm text-gray-400 italic">
              This sub-table has not been generated yet. Use the "Generate all
              sub-tables" button above or click "Generate sub-table" below.
            </p>
          ) : subTable.status === "parse_failed" ? (
            <div>
              <p className="text-sm text-red-500 italic mb-2">
                JSON parse failed — the model output was truncated or malformed.
                Check{" "}
                <code className="text-xs">drafts/tmr/_cells.json</code> for
                the full raw output.
              </p>
              {subTable.rawPreview && (
                <pre className="text-[10px] font-mono text-red-400 bg-red-50 border border-red-200 rounded p-2 overflow-hidden whitespace-pre-wrap break-all leading-relaxed">
                  {subTable.rawPreview.slice(0, 100)}
                  {subTable.rawPreview.length > 100 ? "…" : ""}
                </pre>
              )}
            </div>
          ) : (
            <CellGrid subTable={subTable} />
          )}

          <div className="mt-3 flex gap-2">
            <button
              onClick={() =>
                onToast("Cell editing is coming in a future session.", "info")
              }
              className="text-xs text-gray-500 border border-gray-200 rounded px-3 py-1.5 hover:border-gray-300 hover:text-gray-700 transition-colors"
            >
              Edit cells
            </button>
            <button
              onClick={onGenerate}
              disabled={isGenerating}
              className={`text-xs text-white rounded px-3 py-1.5 transition-colors flex items-center gap-1.5 ${
                isGenerating
                  ? "bg-blue-400 cursor-not-allowed"
                  : "bg-blue-600 hover:bg-blue-700"
              }`}
            >
              {isGenerating ? (
                <>
                  <div className="w-2.5 h-2.5 border border-white border-t-transparent rounded-full animate-spin" />
                  Generating…
                </>
              ) : (
                <>↻ Generate sub-table</>
              )}
            </button>
            <button
              onClick={() => onToast("Sub-table approved.", "success")}
              className="text-xs text-white bg-[#1B4F23] rounded px-3 py-1.5 hover:bg-[#163d1c] transition-colors"
            >
              ✓ Approve
            </button>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

const TmrReview: FC<TmrReviewProps> = ({
  projectDir,
  projectName,
  onBack,
  onSwitchToMr,
  onToast,
}) => {
  const [subTables, setSubTables] = useState<SubTableInfo[]>([]);
  const [loadingCells, setLoadingCells] = useState(true);
  const [sourcesCount, setSourcesCount] = useState<number | null>(null);
  const [expandedSubTable, setExpandedSubTable] = useState<number | null>(null);
  const [generatingAll, setGeneratingAll] = useState(false);
  const [generatingOne, setGeneratingOne] = useState<number | null>(null);
  const [genProgress, setGenProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  const [exporting, setExporting] = useState(false);
  // ISO 8601 timestamp of the most recent TMR generation run, or "" if none
  const [lastRunAt, setLastRunAt] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<Model>(
    () =>
      (localStorage.getItem("agcensus_tmr_model") as Model | null) ??
      DEFAULT_TMR_MODEL,
  );

  // ── Load _cells.json ──────────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoadingCells(true);
      try {
        const loaded = await loadSubTables(projectDir);
        if (!cancelled) {
          setSubTables(loaded);
          setLoadingCells(false);
        }
      } catch {
        if (!cancelled) {
          setSubTables([]);
          setLoadingCells(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  // ── Load sources count ────────────────────────────────────────────────────

  useEffect(() => {
    readTextFile(joinPath(projectDir, "sources", "_index.json"))
      .then((raw) => {
        const list = JSON.parse(raw) as unknown[];
        setSourcesCount(list.length);
      })
      .catch(() => setSourcesCount(0));
  }, [projectDir]);

  // ── Load last TMR run timestamp from audit JSONL files ──────────────────

  useEffect(() => {
    let cancelled = false;

    async function loadLastRun() {
      try {
        const auditDir = joinPath(projectDir, "audit");
        const entries  = await readDir(auditDir);
        const jsonlFiles = entries.filter(
          (e) => !e.isDirectory && e.name.endsWith(".jsonl"),
        );

        let latestTimestamp = "";
        for (const file of jsonlFiles) {
          const content = await readTextFile(joinPath(auditDir, file.name));
          for (const line of content.split(/\r?\n/)) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              const event = JSON.parse(trimmed) as {
                type?: string;
                target?: string;
                timestamp?: string;
              };
              if (
                event.type === "generation_completed" &&
                event.target === "tmr" &&
                typeof event.timestamp === "string"
              ) {
                if (!latestTimestamp || event.timestamp > latestTimestamp) {
                  latestTimestamp = event.timestamp;
                }
              }
            } catch {
              // skip malformed JSONL lines
            }
          }
        }

        if (!cancelled) setLastRunAt(latestTimestamp);
      } catch {
        // audit directory may not exist yet on first use
        if (!cancelled) setLastRunAt("");
      }
    }

    void loadLastRun();
    return () => { cancelled = true; };
  }, [projectDir]);

  // ── Reload a single sub-table from disk after generation ─────────────────

  const reloadSubTable = useCallback(
    async (n: number) => {
      try {
        const cellsPath = [projectDir, "drafts", "tmr", "_cells.json"]
          .map((p) => p.replace(/[/\\]+$/, ""))
          .join("/");
        const raw = await readTextFile(cellsPath);
        const cellsJson = JSON.parse(raw) as Record<string, unknown>;
        const spec = WCA_SUBTABLES[String(n)];
        if (!spec) return;
        const rawEntry = cellsJson[`sub_table_${n}`];
        if (!rawEntry || typeof rawEntry !== "object") return;
        const updated = parseSubTableEntry(
          n,
          rawEntry as Record<string, unknown>,
          spec,
        );
        setSubTables((prev) =>
          prev.map((st) => (st.number === n ? updated : st)),
        );
      } catch {
        // Reload failed — leave existing state
      }
    },
    [projectDir],
  );

  // ── Export XLSX ───────────────────────────────────────────────────────────

  async function handleExport() {
    setExporting(true);
    try {
      const outputPath = await invoke<string>("export_project", {
        projectDir,
        exportType: "tmr",
      });
      // Show only the filename, not the full path
      const filename = outputPath.split(/[/\\]/).pop() ?? outputPath;
      onToast(`TMR exported to ${filename}`, "success");
    } catch (err) {
      onToast(`Export failed: ${String(err)}`, "error");
    } finally {
      setExporting(false);
    }
  }

  // ── Generate all sub-tables ───────────────────────────────────────────────

  async function handleGenerateAll() {
    setGeneratingAll(true);
    setGenProgress({ done: 0, total: 23 });

    const unlisten = await listen<GenerationProgressPayload>(
      "generation-progress",
      (event) => {
        const { type, number, status, message } = event.payload;
        if (type !== "tmr") return;

        if (status === "done") {
          void reloadSubTable(number);
        } else {
          onToast(
            `T${number} failed: ${message ?? "unknown error"}`,
            "error",
          );
        }
        setGenProgress((prev) =>
          prev ? { ...prev, done: prev.done + 1 } : null,
        );
      },
    );

    try {
      const result = await invoke<string>("generate_tmr_subtable", {
        projectDir,
        subTableNumber: 0, // 0 = all
        model: selectedModel,
      });
      onToast(`Generation complete — ${result}.`, "success");
    } catch (err) {
      onToast(String(err), "error");
    } finally {
      unlisten();
      setGeneratingAll(false);
      setGenProgress(null);
    }
  }

  // ── Generate one sub-table ────────────────────────────────────────────────

  async function handleGenerateOne(subTableNumber: number) {
    setGeneratingOne(subTableNumber);

    const unlisten = await listen<GenerationProgressPayload>(
      "generation-progress",
      (event) => {
        const { type, number, status, message } = event.payload;
        if (type !== "tmr" || number !== subTableNumber) return;

        if (status === "done") {
          void reloadSubTable(number);
        } else {
          onToast(
            `T${number} failed: ${message ?? "unknown error"}`,
            "error",
          );
        }
      },
    );

    try {
      const result = await invoke<string>("generate_tmr_subtable", {
        projectDir,
        subTableNumber,
        model: selectedModel,
      });
      onToast(result, "success");
    } catch (err) {
      onToast(String(err), "error");
    } finally {
      unlisten();
      setGeneratingOne(null);
    }
  }

  // ── Summary counts ────────────────────────────────────────────────────────

  const populatedCount = subTables.filter((s) => s.status === "populated").length;
  const partialCount = subTables.filter((s) => s.status === "partial").length;
  const emptyCount = subTables.filter((s) => s.status === "empty").length;
  const failedCount = subTables.filter((s) => s.status === "parse_failed").length;
  const notRunCount = subTables.filter((s) => s.status === "not_generated").length;
  const totalCellsPopulated = subTables.reduce(
    (sum, s) => sum + s.populatedCells,
    0,
  );

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="bg-[#1B4F23] text-white px-6 py-4 sticky top-0 z-10 shadow-sm">
        <div className="max-w-4xl mx-auto flex items-center gap-4">
          <button
            onClick={onBack}
            className="text-green-200 hover:text-white transition-colors text-sm flex items-center gap-1 shrink-0"
          >
            ← Back
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold leading-tight truncate">
              {projectName}
            </div>
            <div className="text-[10px] text-green-200">
              Tables of Main Results
            </div>
            {lastRunAt ? (
              <div className="text-[10px] text-green-300 mt-0.5">
                Last run: {formatLastRun(lastRunAt)}
              </div>
            ) : (
              <div className="text-[10px] text-green-500/50 mt-0.5">
                Last run: never
              </div>
            )}
          </div>
          {/* Export XLSX — outline style to distinguish from the generate button */}
          <button
            onClick={() => void handleExport()}
            disabled={exporting || generatingAll || generatingOne !== null}
            className={`flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg border transition-colors shrink-0 ${
              exporting || generatingAll || generatingOne !== null
                ? "border-white/20 text-white/30 cursor-not-allowed"
                : "border-white/40 text-white/80 hover:bg-white/10 hover:border-white/60"
            }`}
          >
            {exporting ? (
              <>
                <div className="w-3 h-3 border border-white/40 border-t-transparent rounded-full animate-spin" />
                Exporting…
              </>
            ) : (
              <>↓ Export XLSX</>
            )}
          </button>
          <button
            onClick={() => void handleGenerateAll()}
            disabled={generatingAll || generatingOne !== null}
            className={`flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg border transition-colors shrink-0 ${
              generatingAll || generatingOne !== null
                ? "border-green-600 text-green-300 cursor-not-allowed"
                : "border-green-500 text-green-100 hover:bg-white/10 hover:border-green-300"
            }`}
          >
            {generatingAll ? (
              <>
                <div className="w-3 h-3 border border-green-300 border-t-transparent rounded-full animate-spin" />
                Generating…
              </>
            ) : (
              <>↻ Generate all sub-tables</>
            )}
          </button>
        </div>
      </header>

      {/* Model selector bar */}
      <div className="bg-[#163d1c] border-b border-green-900/60 px-6 py-2">
        <div className="max-w-4xl mx-auto flex items-center justify-between gap-4">
          <div className="flex items-center gap-3">
            <span className="text-[10px] text-green-300 shrink-0">Model</span>
            <select
              value={selectedModel}
              onChange={(e) => {
                const m = e.target.value as Model;
                setSelectedModel(m);
                localStorage.setItem("agcensus_tmr_model", m);
              }}
              disabled={generatingAll || generatingOne !== null}
              className="text-xs text-white bg-transparent border border-green-700 rounded-lg px-2 py-1 focus:outline-none disabled:opacity-50 cursor-pointer"
            >
              {([1, 2, 3] as const).map((tier) => (
                <optgroup
                  key={tier}
                  label={
                    tier === 1
                      ? "── Budget"
                      : tier === 2
                      ? "── Mid-range"
                      : "── Premium"
                  }
                >
                  {MODELS_BY_TIER[tier].map((m) => (
                    <option
                      key={m.model}
                      value={m.model}
                      className="text-gray-900 bg-white"
                    >
                      {m.displayName}
                    </option>
                  ))}
                </optgroup>
              ))}
            </select>
          </div>
          {(() => {
            const info = getModelInfo(selectedModel);
            if (!info) return null;
            // TMR estimate: 23 sub-tables × ~1 500 in + 600 out tokens
            const estIn  = 23 * 1_500;
            const estOut = 23 * 600;
            const estCost =
              (estIn * info.inputCostPerM + estOut * info.outputCostPerM) /
              1_000_000;
            return (
              <span className="text-[10px] text-green-400 shrink-0">
                Est. TMR cost: ~${estCost.toFixed(3)} · 23 sub-tables
              </span>
            );
          })()}
        </div>
      </div>

      {/* No-sources banner */}
      {sourcesCount === 0 && (
        <div className="bg-amber-50 border-b border-amber-200 px-6 py-2.5">
          <div className="max-w-4xl mx-auto text-xs text-amber-800">
            No source documents added yet. Go to the{" "}
            <strong>Sources tab</strong> to add census PDFs or Excel files
            before generating.
          </div>
        </div>
      )}

      {/* Generation progress bar */}
      {generatingAll && genProgress && (
        <div className="bg-blue-50 border-b border-blue-200 px-6 py-2">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between text-xs text-gray-600 mb-1.5">
              <span>Generating TMR sub-tables…</span>
              <span className="font-medium tabular-nums">
                {genProgress.done} / {genProgress.total}
              </span>
            </div>
            <div className="h-1.5 bg-blue-100 rounded-full overflow-hidden">
              <div
                className="h-full bg-blue-500 rounded-full transition-all duration-300"
                style={{
                  width: `${Math.round(
                    (genProgress.done / genProgress.total) * 100,
                  )}%`,
                }}
              />
            </div>
          </div>
        </div>
      )}

      {/* Tab bar — MR / TMR switcher */}
      <div className="bg-white border-b border-gray-200 px-6">
        <div className="max-w-4xl mx-auto flex gap-0">
          <button
            onClick={onSwitchToMr}
            className="px-4 py-3 text-sm border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 transition-colors"
          >
            MR sections
          </button>
          <button className="px-4 py-3 text-sm border-b-2 border-blue-500 text-blue-600 font-medium">
            TMR sub-tables
          </button>
        </div>
      </div>

      {/* Status summary bar */}
      {!loadingCells && subTables.length > 0 && (
        <div className="bg-white border-b border-gray-200 px-6 py-2">
          <div className="max-w-4xl mx-auto flex items-center gap-4 text-xs flex-wrap">
            <span className="text-gray-500">TMR sub-tables:</span>
            {populatedCount > 0 && (
              <span className="text-green-600 font-medium">
                {populatedCount} populated
              </span>
            )}
            {partialCount > 0 && (
              <span className="text-blue-600">{partialCount} partial</span>
            )}
            {emptyCount > 0 && (
              <span className="text-yellow-600">{emptyCount} empty</span>
            )}
            {failedCount > 0 && (
              <span className="text-red-600">{failedCount} failed</span>
            )}
            {notRunCount > 0 && (
              <span className="text-gray-400">{notRunCount} not run</span>
            )}
            <span className="text-gray-300">·</span>
            <span className="text-gray-500">
              {totalCellsPopulated.toLocaleString()} cells populated
            </span>
          </div>
        </div>
      )}

      {/* Sub-table list */}
      <main className="max-w-4xl mx-auto px-6 py-6">
        {loadingCells ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 border-2 border-gray-200 border-t-[#1B4F23] rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-2">
            {subTables.map((st) => (
              <SubTableCard
                key={st.number}
                subTable={st}
                isExpanded={expandedSubTable === st.number}
                isGenerating={
                  generatingOne === st.number ||
                  (generatingAll)
                }
                onToggle={() =>
                  setExpandedSubTable(
                    expandedSubTable === st.number ? null : st.number,
                  )
                }
                onGenerate={() => void handleGenerateOne(st.number)}
                onToast={onToast}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default TmrReview;
