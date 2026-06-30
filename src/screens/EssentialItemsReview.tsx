/**
 * Screen — WCA 2020 Essential Items Coverage Assessment.
 *
 * Displays all 23 WCA 2020 essential items with their assessed collection
 * status (collected / partial / not_collected / unclear) for one country
 * project.  Drives the `assess_essential_items` and `reset_essential_items`
 * Tauri commands and streams progress via `"generation-progress"` events.
 */

import { useState, useEffect, useCallback, useRef, type FC } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ToastMessage } from "../types/ui";
import { MODELS_BY_TIER, DEFAULT_MR_MODEL, getModelInfo } from "../providers/model-registry";
import type { Model } from "../providers/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface EssentialItemsReviewProps {
  projectDir: string;
  projectName: string;
  onBack: () => void;
  onOpenSources: () => void;
  onToast: (msg: string, type: ToastMessage["type"]) => void;
}

// ---------------------------------------------------------------------------
// Types — mirrors src/generators/essential-items.ts
// ---------------------------------------------------------------------------

type CollectionStatus = "collected" | "partial" | "not_collected" | "unclear";
type ConfidenceLevel = "high" | "medium" | "low";

interface EssentialItemResult {
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

interface EssentialItemDefinition {
  code: string;
  name: string;
  theme: string;
  short_description: string;
  is_new: boolean;
}

// ---------------------------------------------------------------------------
// Progress event payload (mirrors Rust GenerationProgressPayload)
// ---------------------------------------------------------------------------

interface GenerationProgressPayload {
  type: string;
  number: number;
  status: "done" | "error";
  message?: string;
}

// ---------------------------------------------------------------------------
// Status display helpers
// ---------------------------------------------------------------------------

const STATUS_CONFIG: Record<
  CollectionStatus,
  { label: string; bg: string; text: string; border: string }
> = {
  collected: {
    label: "Collected",
    bg: "bg-green-50",
    text: "text-green-700",
    border: "border-green-200",
  },
  partial: {
    label: "Partial",
    bg: "bg-amber-50",
    text: "text-amber-700",
    border: "border-amber-200",
  },
  not_collected: {
    label: "Not collected",
    bg: "bg-red-50",
    text: "text-red-700",
    border: "border-red-200",
  },
  unclear: {
    label: "Unclear",
    bg: "bg-gray-100",
    text: "text-gray-500",
    border: "border-gray-200",
  },
};

function StatusBadge({ status }: { status: CollectionStatus }) {
  const cfg = STATUS_CONFIG[status];
  return (
    <span
      className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-medium border ${cfg.bg} ${cfg.text} ${cfg.border}`}
    >
      {cfg.label}
    </span>
  );
}

function ConfidenceDot({ level }: { level: ConfidenceLevel }) {
  const colours = { high: "bg-green-400", medium: "bg-amber-400", low: "bg-gray-400" };
  return (
    <span
      className={`inline-block w-2 h-2 rounded-full ${colours[level]}`}
      title={`Confidence: ${level}`}
    />
  );
}

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

function joinPath(...parts: string[]): string {
  return parts.map((p) => p.replace(/[/\\]+$/, "")).join("/");
}

// ---------------------------------------------------------------------------
// Item card
// ---------------------------------------------------------------------------

function ItemCard({
  definition,
  result,
  generating,
  onGenerate,
  onReset,
}: {
  definition: EssentialItemDefinition;
  result: EssentialItemResult | undefined;
  generating: boolean;
  onGenerate: () => void;
  onReset: () => void;
}) {
  const [expanded, setExpanded] = useState(false);
  const status: CollectionStatus = result?.status ?? "unclear";
  const hasResult = !!result;

  return (
    <div
      className={`bg-white border rounded-lg overflow-hidden transition-all ${
        result ? STATUS_CONFIG[status].border : "border-gray-200"
      }`}
    >
      {/* Header row */}
      <div
        className="flex items-center gap-3 px-4 py-3 cursor-pointer hover:bg-gray-50"
        onClick={() => setExpanded((v) => !v)}
      >
        {/* Code badge */}
        <span className="text-[11px] font-mono text-gray-400 w-11 shrink-0">
          {definition.code}
        </span>

        {/* Name */}
        <div className="flex-1 min-w-0">
          <div className="text-sm font-medium text-gray-800 truncate">
            {definition.name}
          </div>
          <div className="text-[11px] text-gray-400 truncate">{definition.theme}</div>
        </div>

        {/* New flag */}
        {definition.is_new && (
          <span className="shrink-0 text-[10px] bg-blue-50 border border-blue-200 text-blue-600 px-1.5 py-0.5 rounded font-medium">
            NEW
          </span>
        )}

        {/* Status badge */}
        {hasResult ? (
          <StatusBadge status={status} />
        ) : (
          <span className="text-[11px] text-gray-300 italic shrink-0">not assessed</span>
        )}

        {/* Confidence dot */}
        {result?.confidence && (
          <ConfidenceDot level={result.confidence} />
        )}

        {/* Per-item action buttons */}
        <div className="flex gap-1.5 shrink-0 ml-1" onClick={(e) => e.stopPropagation()}>
          <button
            onClick={onGenerate}
            disabled={generating}
            title="Assess this item"
            className="text-[11px] border border-gray-200 rounded px-2 py-1 text-gray-500 hover:border-[#1B4F23] hover:text-[#1B4F23] transition-colors disabled:opacity-40 disabled:cursor-not-allowed"
          >
            {generating ? (
              <span className="flex items-center gap-1">
                <span className="w-2.5 h-2.5 border border-gray-300 border-t-transparent rounded-full animate-spin" />
              </span>
            ) : (
              "↻"
            )}
          </button>
          {hasResult && (
            <button
              onClick={onReset}
              title="Reset this item"
              className="text-[11px] border border-gray-200 rounded px-2 py-1 text-gray-500 hover:border-red-300 hover:text-red-600 transition-colors"
            >
              ✕
            </button>
          )}
        </div>

        {/* Expand chevron */}
        <span className="text-gray-300 shrink-0 text-xs">
          {expanded ? "▲" : "▼"}
        </span>
      </div>

      {/* Expanded detail panel */}
      {expanded && (
        <div className="border-t border-gray-100 px-4 py-3 bg-gray-50/60 space-y-2 text-xs">
          <div className="text-gray-600 italic">{definition.short_description}</div>

          {result ? (
            <>
              {result.questionnaire_section && (
                <div>
                  <span className="font-medium text-gray-500">Section: </span>
                  <span className="text-gray-700">{result.questionnaire_section}</span>
                  {result.question_numbers.length > 0 && (
                    <span className="text-gray-400"> · {result.question_numbers.join(", ")}</span>
                  )}
                </div>
              )}
              {result.evidence_excerpt && (
                <div>
                  <span className="font-medium text-gray-500">Evidence: </span>
                  <span className="text-gray-700 italic">"{result.evidence_excerpt}"</span>
                </div>
              )}
              {result.explanation && (
                <div>
                  <span className="font-medium text-gray-500">Explanation: </span>
                  <span className="text-gray-700">{result.explanation}</span>
                </div>
              )}
              {result.notes && (
                <div>
                  <span className="font-medium text-gray-500">Notes: </span>
                  <span className="text-gray-500">{result.notes}</span>
                </div>
              )}
              {result.source_pages.length > 0 && (
                <div className="text-[10px] text-gray-400 font-mono">
                  {result.source_pages.slice(0, 5).join(", ")}
                  {result.source_pages.length > 5 && ` +${result.source_pages.length - 5} more`}
                </div>
              )}
            </>
          ) : (
            <div className="text-gray-400 italic">Not yet assessed — click ↻ to generate.</div>
          )}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Model selector (same pattern as MrReview)
// ---------------------------------------------------------------------------

function ModelSelector({
  value,
  onChange,
}: {
  value: Model;
  onChange: (m: Model) => void;
}) {
  const TIER_LABELS: Record<1 | 2 | 3, string> = {
    1: "Budget",
    2: "Mid-range",
    3: "Premium",
  };

  return (
    <select
      value={value}
      onChange={(e) => onChange(e.target.value as Model)}
      className="text-xs border border-gray-200 rounded-lg px-2.5 py-1.5 bg-white focus:outline-none focus:border-[#1B4F23] text-gray-700"
    >
      {([1, 2, 3] as const).map((tier) => (
        <optgroup key={tier} label={TIER_LABELS[tier]}>
          {MODELS_BY_TIER[tier].map((m) => (
            <option key={m.model} value={m.model}>
              {m.displayName}
            </option>
          ))}
        </optgroup>
      ))}
    </select>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

const EI_MODEL_STORAGE_KEY = "agcensus_ei_model";

const EssentialItemsReview: FC<EssentialItemsReviewProps> = ({
  projectDir,
  projectName,
  onBack,
  onOpenSources,
  onToast,
}) => {
  const [model, setModel] = useState<Model>(
    () => (localStorage.getItem(EI_MODEL_STORAGE_KEY) as Model | null) ?? DEFAULT_MR_MODEL,
  );

  function handleModelChange(m: Model) {
    setModel(m);
    localStorage.setItem(EI_MODEL_STORAGE_KEY, m);
  }

  // Fixed registry of 23 items (could be loaded from disk too, but hardcoded here
  // since the registry JSON is identical to what the generator uses)
  const [registry] = useState<EssentialItemDefinition[]>([]);
  const [assessment, setAssessment] = useState<AssessmentJson | null>(null);
  const [loading, setLoading] = useState(true);

  // Track which item indices (1-based) are currently generating
  const [generatingAll, setGeneratingAll] = useState(false);
  const [generatingItems, setGeneratingItems] = useState<Set<string>>(new Set());
  const [exportingXlsx, setExportingXlsx] = useState(false);

  // ── Load assessment from disk ───────────────────────────────────────────

  const loadAssessment = useCallback(async () => {
    try {
      const raw = await readTextFile(
        joinPath(projectDir, "drafts", "essential-items", "_assessment.json"),
      );
      setAssessment(JSON.parse(raw) as AssessmentJson);
    } catch {
      setAssessment(null);
    }
    setLoading(false);
  }, [projectDir]);

  useEffect(() => {
    void loadAssessment();
  }, [loadAssessment]);

  // ── Listen for generation-progress events ─────────────────────────────

  const completedItemsRef = useRef<Set<number>>(new Set());

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<GenerationProgressPayload>("generation-progress", (event) => {
      if (event.payload.type !== "essential-items") return;
      const { number, status } = event.payload;

      completedItemsRef.current.add(number);

      if (status === "error") {
        onToast(
          `Item ${number} assessment failed: ${event.payload.message ?? "unknown error"}`,
          "error",
        );
      }

      // Reload after each item completes
      void loadAssessment();
    }).then((fn) => {
      unlisten = fn;
    }).catch(() => {
      // listen unavailable
    });

    return () => {
      unlisten?.();
    };
  }, [loadAssessment, onToast]);

  // ── Generate all ────────────────────────────────────────────────────────

  function handleGenerateAll() {
    setGeneratingAll(true);
    completedItemsRef.current.clear();
    void invoke<string>("assess_essential_items", {
      projectDir,
      model,
      itemCode: null,
    })
      .then((msg) => {
        onToast(`Essential items assessment complete — ${msg}.`, "success");
        void loadAssessment();
      })
      .catch((err: unknown) => {
        onToast(`Assessment failed: ${String(err)}`, "error");
      })
      .finally(() => {
        setGeneratingAll(false);
      });
  }

  // ── Generate single item ─────────────────────────────────────────────

  function handleGenerateItem(code: string) {
    setGeneratingItems((prev) => new Set([...prev, code]));
    void invoke<string>("assess_essential_items", {
      projectDir,
      model,
      itemCode: code,
    })
      .then(() => {
        void loadAssessment();
      })
      .catch((err: unknown) => {
        onToast(`Assessment failed for ${code}: ${String(err)}`, "error");
      })
      .finally(() => {
        setGeneratingItems((prev) => {
          const next = new Set(prev);
          next.delete(code);
          return next;
        });
      });
  }

  // ── Reset all ──────────────────────────────────────────────────────────

  function handleResetAll() {
    void invoke("reset_essential_items", { projectDir, itemCode: null })
      .then(() => {
        void loadAssessment();
        onToast("All essential item assessments reset.", "info");
      })
      .catch((err: unknown) => {
        onToast(`Reset failed: ${String(err)}`, "error");
      });
  }

  // ── Reset single item ──────────────────────────────────────────────────

  function handleResetItem(code: string) {
    void invoke("reset_essential_items", { projectDir, itemCode: code })
      .then(() => {
        void loadAssessment();
      })
      .catch((err: unknown) => {
        onToast(`Reset failed: ${String(err)}`, "error");
      });
  }

  // ── Export XLSX ────────────────────────────────────────────────────────

  function handleExportXlsx() {
    setExportingXlsx(true);
    void invoke<string>("export_project", {
      projectDir,
      exportType: "essential-items",
    })
      .then((outputPath) => {
        const filename = outputPath.split(/[/\\]/).pop() ?? outputPath;
        onToast(`Exported: ${filename}`, "success");
        void invoke("open_path", { path: outputPath });
      })
      .catch((err: unknown) => {
        onToast(`Export failed: ${String(err)}`, "error");
      })
      .finally(() => {
        setExportingXlsx(false);
      });
  }

  // ── Derive summary stats ────────────────────────────────────────────────

  const summary = assessment?.summary;
  const questionnaireIndexed = summary?.questionnaire_indexed ?? true;
  const collectedCount = summary?.collected ?? 0;
  const partialCount = summary?.partial ?? 0;
  const notCollectedCount = summary?.not_collected ?? 0;
  const unclearCount = summary?.unclear ?? 0;
  const totalAssessed = summary?.total_assessed ?? 0;

  // Cost estimate: ~2000 input tokens + 300 output tokens per item
  const modelInfo = getModelInfo(model);
  const estimatedCostUsd = modelInfo
    ? 23 *
      (modelInfo.inputCostPerM * 2000 / 1_000_000 +
        modelInfo.outputCostPerM * 300 / 1_000_000)
    : null;

  // ── Render ─────────────────────────────────────────────────────────────

  // Use hardcoded registry for display ordering (we'll also try to load from
  // assessment.items and fall back to definition-only cards for unassessed items)
  const HARDCODED_REGISTRY: EssentialItemDefinition[] = [
    { code: "0101", name: "Identification and location of agricultural holding", theme: "01 — Identification and general characteristics of the holding", short_description: "The holding is identified by a unique number and its geographic location is recorded by administrative unit and/or GPS coordinates.", is_new: false },
    { code: "0103", name: "Legal status of agricultural holder (type of holder)", theme: "01 — Identification and general characteristics of the holding", short_description: "Classifies the holder as a civil person, group of civil persons, or juridical person following the WCA 2020 framework.", is_new: false },
    { code: "0104", name: "Sex of agricultural holder", theme: "01 — Identification and general characteristics of the holding", short_description: "Records whether the agricultural holder is male or female.", is_new: false },
    { code: "0105", name: "Age of agricultural holder", theme: "01 — Identification and general characteristics of the holding", short_description: "Records the age of the agricultural holder in completed years at the time of the census.", is_new: false },
    { code: "0107", name: "Main purpose of production of the holding", theme: "01 — Identification and general characteristics of the holding", short_description: "Identifies whether the holding produces primarily for sale (commercial), for household consumption (subsistence), or both.", is_new: false },
    { code: "0108", name: "Other economic activities of the household", theme: "01 — Identification and general characteristics of the holding", short_description: "Records any non-agricultural income-generating activities carried out by the holder's household during the reference year.", is_new: false },
    { code: "0201", name: "Total area of holding", theme: "02 — Land", short_description: "The total area of all land under the management of the holding, expressed in hectares, regardless of land use.", is_new: false },
    { code: "0202", name: "Area of holding according to land use types", theme: "02 — Land", short_description: "The holding's total area disaggregated by land use type, including temporary crops, permanent crops, pastures, and other.", is_new: false },
    { code: "0203", name: "Area of holding according to land tenure types", theme: "02 — Land", short_description: "The holding's total area disaggregated by land tenure category, such as owner-operated, rented in, or other arrangements.", is_new: true },
    { code: "0302", name: "Area of land actually irrigated: fully and partially controlled irrigation", theme: "03 — Irrigation", short_description: "The area of land on which crops were actually irrigated during the reference year, covering both fully and partially controlled irrigation systems.", is_new: true },
    { code: "0402", name: "Area of temporary crops harvested (for each temporary crop type)", theme: "04 — Crops", short_description: "The area on which each type of temporary crop was harvested at least once during the agricultural year.", is_new: false },
    { code: "0406", name: "Area of productive and non-productive permanent crops in compact plantations (for each permanent crop type)", theme: "04 — Crops", short_description: "The area of land under each type of permanent crop in compact plantations, distinguishing productive from non-productive.", is_new: false },
    { code: "0407", name: "Number of permanent crop trees in scattered plantings (for each tree crop)", theme: "04 — Crops", short_description: "The number of permanent crop trees grown in scattered rather than compact plantation form, recorded by crop type.", is_new: false },
    { code: "0411", name: "Use of each type of fertilizer", theme: "04 — Crops", short_description: "Records whether mineral or organic fertilizers, or both, were applied to the holding during the reference year, by type.", is_new: false },
    { code: "0501", name: "Type of livestock system", theme: "05 — Livestock", short_description: "Classifies the livestock production system of the holding such as sedentary, transhumant, nomadic, or mixed.", is_new: false },
    { code: "0502", name: "Number of animals", theme: "05 — Livestock", short_description: "The total count of each livestock type held by the holding on the census reference date.", is_new: false },
    { code: "0503", name: "Number of female breeding animals", theme: "05 — Livestock", short_description: "The number of female animals of reproductive age kept on the holding, disaggregated by species.", is_new: true },
    { code: "0601", name: "Use of agricultural pesticides", theme: "06 — Agricultural inputs", short_description: "Records whether agricultural pesticides (insecticides, herbicides, fungicides, etc.) were used on the holding during the reference year.", is_new: false },
    { code: "0801", name: "Household size by sex and age groups", theme: "08 — Demography of agricultural holders and households", short_description: "The total number of persons in the agricultural holder's household, disaggregated by sex and broad age group.", is_new: false },
    { code: "0901", name: "Whether working on the holding is the main activity", theme: "09 — Labour", short_description: "Records whether each household member's principal economic activity during the reference year was working on the holding.", is_new: true },
    { code: "0902", name: "Working time on the holding", theme: "09 — Labour", short_description: "The time spent working on the holding during the reference year, expressed in days or hours, by household member.", is_new: false },
    { code: "0903", name: "Number and working time of employees on the holding by sex", theme: "09 — Labour", short_description: "The number of paid employees and the total working time they contributed to the holding during the reference year, by sex.", is_new: false },
    { code: "1201", name: "Presence of aquaculture on the holding", theme: "12 — Aquaculture", short_description: "Records whether aquaculture activities (fish or other aquatic organism farming) are carried out on or associated with the holding.", is_new: false },
  ];

  const displayRegistry = registry.length > 0 ? registry : HARDCODED_REGISTRY;

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="bg-[#1B4F23] text-white px-6 py-4 sticky top-0 z-10 shadow-sm">
        <div className="max-w-5xl mx-auto flex items-center gap-4">
          <button
            onClick={onBack}
            className="text-green-200 hover:text-white transition-colors text-sm flex items-center gap-1 shrink-0"
          >
            ← Overview
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold leading-tight truncate">{projectName}</div>
            <div className="text-[10px] text-green-200 leading-tight">
              WCA 2020 Essential Items Coverage Assessment
            </div>
          </div>
        </div>
      </header>

      <main className="max-w-5xl mx-auto px-6 py-6 space-y-5">
        {/* Questionnaire nudge banner */}
        {!questionnaireIndexed && totalAssessed === 0 && (
          <div className="flex items-start gap-3 bg-amber-50 border border-amber-200 rounded-lg px-4 py-3 text-sm">
            <span className="text-amber-500 shrink-0 mt-0.5">⚠</span>
            <div className="flex-1 text-amber-800">
              <strong>Add a questionnaire before assessing.</strong> No census questionnaire has
              been detected in your indexed sources. Upload and index the census questionnaire in
              the{" "}
              <button
                onClick={onOpenSources}
                className="underline font-medium hover:text-amber-900"
              >
                Sources tab
              </button>{" "}
              for the best assessment accuracy.
            </div>
          </div>
        )}

        {/* Headline metrics */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-3">
          {(
            [
              { label: "Collected", value: collectedCount, color: "text-green-700" },
              { label: "Partial", value: partialCount, color: "text-amber-600" },
              { label: "Not collected", value: notCollectedCount, color: "text-red-600" },
              { label: "Unclear", value: unclearCount, color: "text-gray-400" },
            ] as const
          ).map(({ label, value, color }) => (
            <div key={label} className="bg-white border border-gray-200 rounded-lg p-4">
              <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">{label}</div>
              <div className={`text-2xl font-bold leading-tight ${color}`}>{value}</div>
              <div className="text-[10px] text-gray-400 mt-0.5">of 23 items</div>
            </div>
          ))}
        </div>

        {/* Action bar */}
        <div className="flex flex-wrap items-center gap-2">
          <ModelSelector value={model} onChange={handleModelChange} />

          {estimatedCostUsd !== null && (
            <span className="text-[11px] text-gray-400 tabular-nums">
              ~${estimatedCostUsd.toFixed(3)} for 23 items
            </span>
          )}

          <button
            onClick={handleGenerateAll}
            disabled={generatingAll}
            className={`text-xs font-medium rounded-lg px-4 py-2 transition-colors flex items-center gap-1.5 ${
              generatingAll
                ? "bg-gray-200 text-gray-400 cursor-not-allowed"
                : "bg-[#1B4F23] text-white hover:bg-[#163d1c]"
            }`}
          >
            {generatingAll ? (
              <>
                <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
                Assessing…
              </>
            ) : (
              "↻ Generate all"
            )}
          </button>

          <button
            onClick={handleResetAll}
            disabled={generatingAll}
            className="text-xs border border-gray-200 rounded-lg px-3 py-2 text-gray-500 hover:border-red-300 hover:text-red-600 transition-colors disabled:opacity-40"
          >
            Reset all
          </button>

          <div className="ml-auto">
            <button
              onClick={handleExportXlsx}
              disabled={exportingXlsx || totalAssessed === 0}
              className="text-xs border border-gray-200 rounded-lg px-3 py-2 text-gray-600 hover:border-gray-300 hover:text-gray-800 transition-colors disabled:opacity-40 flex items-center gap-1.5"
            >
              {exportingXlsx ? (
                <>
                  <div className="w-3 h-3 border border-gray-300 border-t-transparent rounded-full animate-spin" />
                  Exporting…
                </>
              ) : (
                "↓ Export assessment (XLSX)"
              )}
            </button>
          </div>
        </div>

        {/* Item cards */}
        {loading ? (
          <div className="flex items-center gap-2 py-8 text-xs text-gray-400">
            <div className="w-3 h-3 border border-gray-300 border-t-[#1B4F23] rounded-full animate-spin" />
            Loading assessment…
          </div>
        ) : (
          <div className="space-y-2">
            {displayRegistry.map((def) => {
              const result = assessment?.items[def.code];
              const isGenerating = generatingAll || generatingItems.has(def.code);
              return (
                <ItemCard
                  key={def.code}
                  definition={def}
                  result={result}
                  generating={isGenerating}
                  onGenerate={() => handleGenerateItem(def.code)}
                  onReset={() => handleResetItem(def.code)}
                />
              );
            })}
          </div>
        )}

        {/* Legend */}
        <div className="flex flex-wrap gap-4 pt-2 text-[11px] text-gray-400">
          {Object.entries(STATUS_CONFIG).map(([status, cfg]) => (
            <span key={status} className={`flex items-center gap-1.5 ${cfg.text}`}>
              <span className={`w-2 h-2 rounded-full border ${cfg.bg} ${cfg.border}`} />
              {cfg.label}
            </span>
          ))}
          <span className="flex items-center gap-1.5 ml-4">
            <span className="w-2 h-2 rounded-full bg-green-400" /> High confidence
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-amber-400" /> Medium
          </span>
          <span className="flex items-center gap-1.5">
            <span className="w-2 h-2 rounded-full bg-gray-400" /> Low
          </span>
        </div>
      </main>
    </div>
  );
};

export default EssentialItemsReview;
