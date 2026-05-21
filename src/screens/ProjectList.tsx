/**
 * Screen 1 — Country project list.
 *
 * Displays all country projects found in the AgCensus base directory as cards
 * showing: country, census round, MR/TMR completion status, and last modified
 * date.  Clicking a card navigates to the MR section review screen.
 */

import { useState, type FC } from "react";
import { useProjects } from "../hooks/useProjects";
import type { ProjectInfo, ToastMessage } from "../types/ui";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProjectListProps {
  onOpenProject: (project: ProjectInfo) => void;
  onToast: (msg: string, type: ToastMessage["type"]) => void;
}

// ---------------------------------------------------------------------------
// Sub-components
// ---------------------------------------------------------------------------

/** Compact progress bar for MR / TMR status (filled segments). */
function StatusBar({
  ok,
  total,
  label,
  color,
}: {
  ok: number;
  total: number;
  label: string;
  color: "green" | "blue";
}) {
  const barColor =
    color === "green"
      ? "bg-[#1B4F23]"
      : "bg-blue-600";
  const emptyColor = "bg-gray-200";
  const pct = total > 0 ? Math.round((ok / total) * 100) : 0;
  return (
    <div className="flex items-center gap-2">
      <span className="text-xs text-gray-500 w-7 shrink-0">{label}</span>
      <div className="flex gap-0.5 flex-1">
        {Array.from({ length: total }).map((_, i) => (
          <div
            key={i}
            className={`h-1.5 flex-1 rounded-sm ${i < ok ? barColor : emptyColor}`}
          />
        ))}
      </div>
      <span className="text-xs text-gray-600 tabular-nums w-10 text-right shrink-0">
        {ok}/{total}
        <span className="text-gray-400"> ({pct}%)</span>
      </span>
    </div>
  );
}

/** Country ISO3 badge (FAO green). */
function IsoBadge({ iso3 }: { iso3: string }) {
  return (
    <span className="inline-block bg-[#1B4F23] text-white text-[10px] font-mono font-semibold px-1.5 py-0.5 rounded leading-tight">
      {iso3.toUpperCase()}
    </span>
  );
}

/** Format an ISO 8601 date/datetime to "DD MMM YYYY". */
function fmtDate(iso: string): string {
  try {
    return new Intl.DateTimeFormat("en-GB", {
      day: "2-digit",
      month: "short",
      year: "numeric",
    }).format(new Date(iso));
  } catch {
    return iso.slice(0, 10);
  }
}

/** One project card. */
function ProjectCard({
  project,
  onClick,
}: {
  project: ProjectInfo;
  onClick: () => void;
}) {
  const { manifest, mrSectionsOk, mrSectionsTotal, tmrSubTablesOk, tmrSubTablesTotal } =
    project;
  const methodShort =
    manifest.methodology_type.replace("complete enumeration", "complete enum.").slice(0, 24);

  return (
    <button
      onClick={onClick}
      className="w-full text-left border border-gray-200 rounded-lg p-4 hover:border-[#1B4F23] hover:shadow-md transition-all duration-150 bg-white group"
    >
      {/* Header row */}
      <div className="flex items-start justify-between gap-3 mb-3">
        <div className="flex items-start gap-2">
          <IsoBadge iso3={manifest.country_iso3} />
          <div>
            <div className="text-sm font-semibold text-gray-900 group-hover:text-[#1B4F23] leading-tight">
              {manifest.country}
            </div>
            <div className="text-xs text-gray-500 mt-0.5">
              {manifest.census_round} · {methodShort}
            </div>
          </div>
        </div>
        <div className="text-xs text-gray-400 shrink-0 pt-0.5">
          {fmtDate(project.lastModified)}
        </div>
      </div>

      {/* Census name */}
      <div className="text-xs text-gray-600 mb-3 line-clamp-1">
        {manifest.census_name}
      </div>

      {/* Status bars */}
      <div className="space-y-1.5">
        <StatusBar ok={mrSectionsOk} total={mrSectionsTotal} label="MR" color="green" />
        <StatusBar ok={tmrSubTablesOk} total={tmrSubTablesTotal} label="TMR" color="blue" />
      </div>
    </button>
  );
}

/** Empty state shown when no projects found. */
function EmptyState({
  baseDir,
  onChangeDir,
}: {
  baseDir: string;
  onChangeDir: () => void;
}) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center px-6">
      <div className="w-16 h-16 rounded-full bg-gray-100 flex items-center justify-center mb-4">
        <svg
          className="w-8 h-8 text-gray-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M3 7v10a2 2 0 002 2h14a2 2 0 002-2V9a2 2 0 00-2-2h-6l-2-2H5a2 2 0 00-2 2z"
          />
        </svg>
      </div>
      <h2 className="text-base font-semibold text-gray-800 mb-1">
        No projects found
      </h2>
      <p className="text-sm text-gray-500 max-w-sm mb-2">
        Looking in:{" "}
        <code className="bg-gray-100 px-1 py-0.5 rounded text-xs break-all">
          {baseDir}
        </code>
      </p>
      <p className="text-sm text-gray-500 max-w-sm mb-6">
        Create that directory and run the generator CLI scripts to populate it,
        or choose a different folder.
      </p>
      <button
        onClick={onChangeDir}
        className="text-sm text-[#1B4F23] underline hover:no-underline"
      >
        Change project folder
      </button>
    </div>
  );
}

/** Loading spinner. */
function Spinner() {
  return (
    <div className="flex items-center justify-center py-24">
      <div className="w-8 h-8 border-2 border-gray-200 border-t-[#1B4F23] rounded-full animate-spin" />
    </div>
  );
}

/** Error state. */
function ErrorState({ message, onRetry }: { message: string; onRetry: () => void }) {
  return (
    <div className="flex flex-col items-center justify-center py-24 text-center px-6">
      <div className="w-16 h-16 rounded-full bg-red-50 flex items-center justify-center mb-4">
        <svg
          className="w-8 h-8 text-red-400"
          fill="none"
          stroke="currentColor"
          viewBox="0 0 24 24"
        >
          <path
            strokeLinecap="round"
            strokeLinejoin="round"
            strokeWidth={1.5}
            d="M12 9v4m0 4h.01M10.29 3.86L1.82 18a2 2 0 001.71 3h16.94a2 2 0 001.71-3L13.71 3.86a2 2 0 00-3.42 0z"
          />
        </svg>
      </div>
      <h2 className="text-base font-semibold text-gray-800 mb-2">
        Could not load projects
      </h2>
      <pre className="text-xs text-gray-500 bg-gray-50 border border-gray-200 rounded p-3 max-w-md text-left whitespace-pre-wrap mb-4">
        {message}
      </pre>
      <button
        onClick={onRetry}
        className="px-4 py-2 text-sm bg-[#1B4F23] text-white rounded hover:bg-[#163d1c] transition-colors"
      >
        Retry
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Change-folder modal
// ---------------------------------------------------------------------------

function ChangeDirModal({
  currentDir,
  onSave,
  onCancel,
}: {
  currentDir: string;
  onSave: (dir: string) => void;
  onCancel: () => void;
}) {
  const [value, setValue] = useState(currentDir);
  return (
    <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
      <div className="bg-white rounded-xl shadow-xl w-full max-w-md p-6">
        <h2 className="text-base font-semibold text-gray-900 mb-1">
          Project folder
        </h2>
        <p className="text-xs text-gray-500 mb-4">
          Absolute path to the directory containing your AgCensus country
          project subdirectories.
        </p>
        <input
          type="text"
          value={value}
          onChange={(e) => setValue(e.target.value)}
          className="w-full border border-gray-300 rounded-lg px-3 py-2 text-sm font-mono focus:outline-none focus:border-[#1B4F23] focus:ring-1 focus:ring-[#1B4F23] mb-4"
          placeholder="e.g. C:\Users\user\Documents\AgCensus"
        />
        <div className="flex justify-end gap-2">
          <button
            onClick={onCancel}
            className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
          >
            Cancel
          </button>
          <button
            onClick={() => onSave(value.trim())}
            disabled={!value.trim()}
            className="px-4 py-2 text-sm bg-[#1B4F23] text-white rounded-lg hover:bg-[#163d1c] disabled:opacity-50 disabled:cursor-not-allowed transition-colors"
          >
            Save & reload
          </button>
        </div>
      </div>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

const ProjectList: FC<ProjectListProps> = ({ onOpenProject, onToast }) => {
  const { projects, loading, error, baseDir, setBaseDir, refresh } =
    useProjects();
  const [showChangeDirModal, setShowChangeDirModal] = useState(false);

  function handlePlaceholderAction(label: string) {
    onToast(`${label} is coming in a future session.`, "info");
  }

  function handleSaveDir(dir: string) {
    setBaseDir(dir);
    setShowChangeDirModal(false);
  }

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="bg-[#1B4F23] text-white px-6 py-4 flex items-center justify-between sticky top-0 z-10 shadow-sm">
        <div className="flex items-center gap-3">
          <div className="w-8 h-8 rounded bg-white/20 flex items-center justify-center">
            <span className="text-base font-bold leading-none">A</span>
          </div>
          <div>
            <div className="text-sm font-semibold leading-tight">
              AgCensus Compiler
            </div>
            <div className="text-[10px] text-green-200 leading-tight">
              FAO WCA 2020
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => setShowChangeDirModal(true)}
            className="text-xs text-green-200 hover:text-white border border-green-700 hover:border-green-400 rounded px-2.5 py-1.5 transition-colors"
            title="Change project folder"
          >
            <span className="mr-1">📁</span>
            {baseDir ? "Change folder" : "Set folder"}
          </button>
          <button
            onClick={refresh}
            className="text-xs text-green-200 hover:text-white border border-green-700 hover:border-green-400 rounded px-2.5 py-1.5 transition-colors"
            title="Refresh project list"
          >
            ↻ Refresh
          </button>
          <button
            onClick={() => handlePlaceholderAction("Import bundle")}
            className="text-xs text-green-200 hover:text-white border border-green-700 hover:border-green-400 rounded px-2.5 py-1.5 transition-colors"
          >
            Import bundle
          </button>
          <button
            onClick={() => handlePlaceholderAction("New project")}
            className="text-xs bg-white text-[#1B4F23] font-semibold rounded px-3 py-1.5 hover:bg-green-50 transition-colors"
          >
            + New project
          </button>
        </div>
      </header>

      {/* Breadcrumb / current folder */}
      {baseDir && (
        <div className="px-6 py-2 border-b border-gray-200 bg-white">
          <span className="text-xs text-gray-400">Projects in: </span>
          <span className="text-xs text-gray-600 font-mono">{baseDir}</span>
        </div>
      )}

      {/* Main content */}
      <main className="max-w-5xl mx-auto px-6 py-6">
        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState
            message={error}
            onRetry={() => {
              setShowChangeDirModal(true);
            }}
          />
        ) : projects.length === 0 ? (
          <EmptyState
            baseDir={baseDir}
            onChangeDir={() => setShowChangeDirModal(true)}
          />
        ) : (
          <>
            <div className="flex items-center justify-between mb-4">
              <h1 className="text-base font-semibold text-gray-800">
                {projects.length} project{projects.length !== 1 ? "s" : ""}
              </h1>
            </div>
            <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-3 gap-4">
              {projects.map((p) => (
                <ProjectCard
                  key={p.dir}
                  project={p}
                  onClick={() => onOpenProject(p)}
                />
              ))}
            </div>
          </>
        )}
      </main>

      {/* Change folder modal */}
      {showChangeDirModal && (
        <ChangeDirModal
          currentDir={baseDir}
          onSave={handleSaveDir}
          onCancel={() => setShowChangeDirModal(false)}
        />
      )}
    </div>
  );
};

export default ProjectList;
