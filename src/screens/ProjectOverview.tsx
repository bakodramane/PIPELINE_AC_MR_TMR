/**
 * Screen — Project overview.
 *
 * Shown after clicking a project card in the project list.  Displays:
 *   - Four status metric cards (Sources, MR sections, TMR cells, Issues)
 *   - Two generator cards side-by-side (MR draft, TMR draft)
 *   - Navigation tab row (MR draft, TMR draft, Sources, Issues, Audit log)
 *
 * This is the hub screen between the project list (Screen 1) and the
 * detail review screens (MR / TMR).
 *
 * Session 14: "Generate all" buttons now call real Tauri commands with
 * spinner feedback while generation runs.
 */

import { useState, type FC } from "react";
import { invoke } from "@tauri-apps/api/core";
import type { ProjectInfo, ToastMessage } from "../types/ui";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProjectOverviewProps {
  project: ProjectInfo;
  onBack: () => void;
  onOpenMrReview: () => void;
  onOpenTmrReview: () => void;
  onToast: (msg: string, type: ToastMessage["type"]) => void;
}

// ---------------------------------------------------------------------------
// Metric card
// ---------------------------------------------------------------------------

function MetricCard({
  label,
  value,
  sub,
  progress,
}: {
  label: string;
  value: string | number;
  sub?: string;
  progress?: number; // 0–1, shows a thin bar if provided
}) {
  return (
    <div className="bg-white border border-gray-200 rounded-lg p-4">
      <div className="text-[10px] text-gray-400 uppercase tracking-wider mb-1">
        {label}
      </div>
      <div className="text-2xl font-bold text-gray-900 leading-tight">
        {value}
      </div>
      {sub && <div className="text-xs text-gray-400 mt-0.5">{sub}</div>}
      {progress !== undefined && (
        <div className="mt-2 h-1 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-[#1B4F23] rounded-full transition-all"
            style={{ width: `${Math.round(progress * 100)}%` }}
          />
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Generator card
// ---------------------------------------------------------------------------

function GeneratorCard({
  title,
  subtitle,
  okCount,
  okLabel,
  totalCount,
  notRunCount,
  generating,
  onOpen,
  onGenerate,
}: {
  title: string;
  subtitle: string;
  okCount: number;
  okLabel: string;
  totalCount: number;
  notRunCount: number;
  generating: boolean;
  onOpen: () => void;
  onGenerate: () => void;
}) {
  const pct = totalCount > 0 ? Math.round((okCount / totalCount) * 100) : 0;

  return (
    <div className="bg-white border border-gray-200 rounded-lg p-5 flex flex-col gap-4">
      {/* Header */}
      <div>
        <div className="text-sm font-semibold text-gray-900">{title}</div>
        <div className="text-[10px] text-gray-400 mt-0.5">{subtitle}</div>
      </div>

      {/* Status summary */}
      <div className="space-y-2">
        <div className="flex items-center justify-between text-xs">
          <span className="text-gray-500">{okLabel}</span>
          <span className="font-medium text-gray-800 tabular-nums">
            {okCount} / {totalCount}
            <span className="text-gray-400 font-normal ml-1">({pct}%)</span>
          </span>
        </div>
        <div className="h-1.5 bg-gray-100 rounded-full overflow-hidden">
          <div
            className="h-full bg-[#1B4F23] rounded-full transition-all"
            style={{ width: `${pct}%` }}
          />
        </div>
        {notRunCount > 0 && (
          <div className="text-[10px] text-gray-400">
            {notRunCount} not yet generated
          </div>
        )}
      </div>

      {/* Actions */}
      <div className="flex gap-2 mt-auto">
        <button
          onClick={onOpen}
          className="flex-1 text-xs font-medium text-white bg-[#1B4F23] rounded-lg px-3 py-2 hover:bg-[#163d1c] transition-colors"
        >
          ↗ Open review
        </button>
        <button
          onClick={onGenerate}
          disabled={generating}
          className={`text-xs border rounded-lg px-3 py-2 transition-colors flex items-center gap-1.5 ${
            generating
              ? "border-gray-200 text-gray-300 cursor-not-allowed"
              : "text-gray-500 border-gray-200 hover:border-gray-300 hover:text-gray-700"
          }`}
        >
          {generating ? (
            <>
              <div className="w-2.5 h-2.5 border border-gray-300 border-t-transparent rounded-full animate-spin" />
              Generating…
            </>
          ) : (
            <>↻ Generate all</>
          )}
        </button>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Navigation tab
// ---------------------------------------------------------------------------

function NavTab({
  label,
  active,
  onClick,
}: {
  label: string;
  active?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      onClick={onClick}
      className={`px-4 py-3 text-sm border-b-2 transition-colors whitespace-nowrap ${
        active
          ? "border-[#1B4F23] text-[#1B4F23] font-medium"
          : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300"
      }`}
    >
      {label}
    </button>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

const ProjectOverview: FC<ProjectOverviewProps> = ({
  project,
  onBack,
  onOpenMrReview,
  onOpenTmrReview,
  onToast,
}) => {
  const [mrGenerating, setMrGenerating] = useState(false);
  const [tmrGenerating, setTmrGenerating] = useState(false);

  const {
    manifest,
    mrSectionsOk,
    mrSectionsTotal,
    tmrSubTablesOk,
    tmrSubTablesTotal,
    tmrCellsOk,
    tmrCellsTotal,
  } = project;

  const mrNotRun = mrSectionsTotal - mrSectionsOk;
  const tmrNotRun = tmrSubTablesTotal - tmrSubTablesOk;

  function handleGenerateMr() {
    setMrGenerating(true);
    void invoke<string>("generate_mr_sections", {
      projectDir: project.dir,
      model: "deepseek-v4-flash",
    })
      .then((msg) => {
        onToast(`MR generation complete — ${msg}.`, "success");
      })
      .catch((err: unknown) => {
        onToast(`MR generation failed: ${String(err)}`, "error");
      })
      .finally(() => {
        setMrGenerating(false);
      });
  }

  function handleGenerateTmr() {
    setTmrGenerating(true);
    void invoke<string>("generate_tmr_subtable", {
      projectDir: project.dir,
      subTableNumber: 0, // 0 = all
      model: "deepseek-v4-flash",
    })
      .then((msg) => {
        onToast(`TMR generation complete — ${msg}.`, "success");
      })
      .catch((err: unknown) => {
        onToast(`TMR generation failed: ${String(err)}`, "error");
      })
      .finally(() => {
        setTmrGenerating(false);
      });
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="bg-[#1B4F23] text-white px-6 py-4 sticky top-0 z-10 shadow-sm">
        <div className="max-w-5xl mx-auto flex items-center gap-4">
          <button
            onClick={onBack}
            className="text-green-200 hover:text-white transition-colors text-sm flex items-center gap-1 shrink-0"
          >
            ← Projects
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold leading-tight truncate">
              {manifest.country} {manifest.reference_year}
            </div>
            <div className="text-[10px] text-green-200 leading-tight truncate">
              {manifest.census_name}
            </div>
          </div>
          <div className="flex items-center gap-2 shrink-0">
            <span className="text-[10px] bg-white/10 px-2 py-0.5 rounded font-mono">
              {manifest.country_iso3.toUpperCase()}
            </span>
            <span className="text-[10px] text-green-200">
              {manifest.census_round}
            </span>
          </div>
        </div>
      </header>

      {/* Project subtitle bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-2">
        <div className="max-w-5xl mx-auto flex items-center gap-3 text-xs text-gray-500">
          <span>{manifest.methodology_type}</span>
          <span className="text-gray-300">·</span>
          <span>{manifest.statistical_unit}</span>
          <span className="text-gray-300">·</span>
          <span className="font-mono text-[10px] text-gray-400 truncate max-w-xs">
            {project.dir}
          </span>
        </div>
      </div>

      {/* Main content */}
      <main className="max-w-5xl mx-auto px-6 py-6 space-y-6">
        {/* Metric cards */}
        <div className="grid grid-cols-2 sm:grid-cols-4 gap-4">
          <MetricCard
            label="Sources indexed"
            value={manifest.source_documents.length}
            sub={
              manifest.source_documents.length === 1
                ? "document"
                : "documents"
            }
          />
          <MetricCard
            label="MR sections"
            value={`${mrSectionsOk} / ${mrSectionsTotal}`}
            sub={`${Math.round((mrSectionsOk / mrSectionsTotal) * 100)}% complete`}
            progress={mrSectionsOk / mrSectionsTotal}
          />
          <MetricCard
            label="TMR cells filled"
            value={`${tmrCellsOk} / ${tmrCellsTotal}`}
            sub={`${Math.round((tmrCellsOk / tmrCellsTotal) * 100)}% of 388 cells`}
            progress={tmrCellsOk / tmrCellsTotal}
          />
          <MetricCard
            label="Open issues"
            value={0}
            sub="issues queue empty"
          />
        </div>

        {/* Generator cards */}
        <div className="grid grid-cols-1 sm:grid-cols-2 gap-4">
          <GeneratorCard
            title="Metadata Review Draft"
            subtitle="15 narrative sections with evidence citations"
            okCount={mrSectionsOk}
            okLabel="Sections with claims"
            totalCount={mrSectionsTotal}
            notRunCount={mrNotRun}
            generating={mrGenerating}
            onOpen={onOpenMrReview}
            onGenerate={handleGenerateMr}
          />
          <GeneratorCard
            title="Tables of Main Results"
            subtitle="23 WCA 2020 sub-tables with source citations per cell"
            okCount={tmrSubTablesOk}
            okLabel="Sub-tables with data"
            totalCount={tmrSubTablesTotal}
            notRunCount={tmrNotRun}
            generating={tmrGenerating}
            onOpen={onOpenTmrReview}
            onGenerate={handleGenerateTmr}
          />
        </div>

        {/* Navigation tabs */}
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="border-b border-gray-200 px-2 flex gap-0 overflow-x-auto">
            <NavTab label="MR draft" onClick={onOpenMrReview} />
            <NavTab label="TMR draft" onClick={onOpenTmrReview} />
            <NavTab
              label="Sources"
              onClick={() =>
                onToast("Sources view — coming in a future session.", "info")
              }
            />
            <NavTab
              label="Issues"
              onClick={() =>
                onToast("Issues queue — coming in a future session.", "info")
              }
            />
            <NavTab
              label="Audit log"
              onClick={() =>
                onToast("Audit log — coming in a future session.", "info")
              }
            />
          </div>
          <div className="px-6 py-8 text-center">
            <p className="text-sm text-gray-400">
              Select a tab above to begin reviewing this project.
            </p>
          </div>
        </div>
      </main>
    </div>
  );
};

export default ProjectOverview;
