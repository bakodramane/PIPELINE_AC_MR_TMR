/**
 * Screen 1 — Country project list.
 *
 * Displays all country projects found in the AgCensus base directory as cards
 * showing: country, census round, MR/TMR completion status, and last modified
 * date.  Clicking a card navigates to the project overview screen.
 *
 * Session 15: "+ New project" now shows an inline form that invokes the
 * `create_project` Tauri command, which writes BOM-free UTF-8 files via Rust
 * std::fs (no PowerShell WriteAllText BOM byte-order-mark issue).
 */

import { useState, type FC } from "react";
import { invoke } from "@tauri-apps/api/core";
import { open } from "@tauri-apps/plugin-dialog";
import { useProjects } from "../hooks/useProjects";
import type { ProjectInfo, ToastMessage } from "../types/ui";
import { COUNTRY_TO_ISO3 } from "../data/iso3";

// ---------------------------------------------------------------------------
// Helpers & constants for new project form
// ---------------------------------------------------------------------------

/** Build an absolute project path from a base dir + folder name. */
function joinProjectPath(base: string, name: string): string {
  const sep = base.includes("\\") ? "\\" : "/";
  return `${base.replace(/[/\\]+$/, "")}${sep}${name}`;
}

const METHODOLOGY_OPTIONS = [
  "sample-based",
  "classical",
  "register-based",
  "complete enumeration",
  "modular",
  "integrated",
] as const;

interface NewProjectFormData {
  country: string;
  iso3: string;
  censusName: string;
  referenceYear: string;
  methodologyType: string;
  statisticalUnit: string;
}

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
  const barColor = color === "green" ? "bg-[#1B4F23]" : "bg-blue-600";
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
  const {
    manifest,
    mrSectionsOk,
    mrSectionsTotal,
    tmrSubTablesOk,
    tmrSubTablesTotal,
  } = project;
  const methodShort = manifest.methodology_type
    .replace("complete enumeration", "complete enum.")
    .slice(0, 24);

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
        <StatusBar
          ok={mrSectionsOk}
          total={mrSectionsTotal}
          label="MR"
          color="green"
        />
        <StatusBar
          ok={tmrSubTablesOk}
          total={tmrSubTablesTotal}
          label="TMR"
          color="blue"
        />
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
        No projects yet
      </h2>
      <p className="text-sm text-gray-500 max-w-sm mb-6">
        Click <strong>+ New project</strong> to create your first country project.
      </p>
      <p className="text-xs text-gray-400 max-w-sm mb-2">
        Projects folder:{" "}
        <code className="bg-gray-100 px-1 py-0.5 rounded break-all">
          {baseDir}
        </code>
      </p>
      <button
        onClick={onChangeDir}
        className="text-sm text-[#1B4F23] underline hover:no-underline"
      >
        Change project folder
      </button>
      <p className="text-xs text-gray-400 max-w-sm mt-3">
        Projects will be stored in an &lsquo;AgCensus&rsquo; folder inside your chosen location.
      </p>
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
function ErrorState({
  message,
  onRetry,
}: {
  message: string;
  onRetry: () => void;
}) {
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
// New project inline form
// ---------------------------------------------------------------------------

function NewProjectForm({
  onSubmit,
  onCancel,
  creating,
}: {
  onSubmit: (data: NewProjectFormData) => void;
  onCancel: () => void;
  creating: boolean;
}) {
  const [form, setForm] = useState<NewProjectFormData>({
    country: "",
    iso3: "",
    censusName: "",
    referenceYear: "",
    methodologyType: "sample-based",
    statisticalUnit: "agricultural holding",
  });

  function setField(field: keyof NewProjectFormData, value: string) {
    setForm((f) => ({ ...f, [field]: value }));
  }

  const valid = Boolean(
    form.country.trim() &&
      form.iso3.trim().length === 3 &&
      form.censusName.trim() &&
      form.referenceYear.trim(),
  );

  return (
    <form
      onSubmit={(e) => {
        e.preventDefault();
        if (valid) onSubmit(form);
      }}
      className="bg-white border border-[#1B4F23]/30 rounded-lg p-5 mb-6 shadow-sm"
    >
      <div className="flex items-center justify-between mb-4">
        <h2 className="text-sm font-semibold text-gray-900">New project</h2>
        <button
          type="button"
          onClick={onCancel}
          className="text-gray-400 hover:text-gray-600 text-xl leading-none"
        >
          ×
        </button>
      </div>

      <div className="grid grid-cols-1 sm:grid-cols-2 gap-3 mb-4">
        {/* Reference year */}
        <div>
          <label className="block text-[10px] text-gray-500 uppercase tracking-wide mb-1">
            Reference year
          </label>
          <input
            type="text"
            value={form.referenceYear}
            onChange={(e) => setField("referenceYear", e.target.value)}
            placeholder="e.g. 2024"
            required
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#1B4F23] focus:ring-1 focus:ring-[#1B4F23]"
          />
        </div>

        {/* Country */}
        <div>
          <label className="block text-[10px] text-gray-500 uppercase tracking-wide mb-1">
            Country
          </label>
          <input
            type="text"
            value={form.country}
            onChange={(e) => setField("country", e.target.value)}
            onBlur={(e) => {
              const country = e.target.value.trim();
              if (!country) return;
              const iso3Found = COUNTRY_TO_ISO3[country.toLowerCase()];
              setForm((f) => {
                const year =
                  f.referenceYear.trim() ||
                  new Date().getFullYear().toString();
                return {
                  ...f,
                  iso3:
                    iso3Found && !f.iso3.trim() ? iso3Found : f.iso3,
                  censusName: !f.censusName.trim()
                    ? `${country} Agricultural Census ${year}`
                    : f.censusName,
                };
              });
            }}
            placeholder="e.g. Pakistan"
            required
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#1B4F23] focus:ring-1 focus:ring-[#1B4F23]"
          />
        </div>

        {/* ISO3 */}
        <div>
          <label className="block text-[10px] text-gray-500 uppercase tracking-wide mb-1">
            ISO3 code
          </label>
          <input
            type="text"
            value={form.iso3}
            onChange={(e) => setField("iso3", e.target.value.slice(0, 3))}
            placeholder="e.g. PAK"
            maxLength={3}
            required
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm font-mono uppercase focus:outline-none focus:border-[#1B4F23] focus:ring-1 focus:ring-[#1B4F23]"
          />
        </div>

        {/* Methodology type */}
        <div>
          <label className="block text-[10px] text-gray-500 uppercase tracking-wide mb-1">
            Methodology type
          </label>
          <select
            value={form.methodologyType}
            onChange={(e) => setField("methodologyType", e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#1B4F23] focus:ring-1 focus:ring-[#1B4F23] bg-white"
          >
            {METHODOLOGY_OPTIONS.map((opt) => (
              <option key={opt} value={opt}>
                {opt}
              </option>
            ))}
          </select>
        </div>

        {/* Census name */}
        <div className="sm:col-span-2">
          <label className="block text-[10px] text-gray-500 uppercase tracking-wide mb-1">
            Census name
          </label>
          <input
            type="text"
            value={form.censusName}
            onChange={(e) => setField("censusName", e.target.value)}
            placeholder="e.g. Pakistan Agricultural Census 2024"
            required
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#1B4F23] focus:ring-1 focus:ring-[#1B4F23]"
          />
        </div>

        {/* Statistical unit */}
        <div className="sm:col-span-2">
          <label className="block text-[10px] text-gray-500 uppercase tracking-wide mb-1">
            Statistical unit
          </label>
          <input
            type="text"
            value={form.statisticalUnit}
            onChange={(e) => setField("statisticalUnit", e.target.value)}
            className="w-full border border-gray-300 rounded-lg px-3 py-1.5 text-sm focus:outline-none focus:border-[#1B4F23] focus:ring-1 focus:ring-[#1B4F23]"
          />
        </div>
      </div>

      <div className="flex justify-end gap-2">
        <button
          type="button"
          onClick={onCancel}
          className="px-4 py-2 text-sm text-gray-600 hover:text-gray-800 border border-gray-200 rounded-lg hover:border-gray-300 transition-colors"
        >
          Cancel
        </button>
        <button
          type="submit"
          disabled={!valid || creating}
          className="px-4 py-2 text-sm bg-[#1B4F23] text-white rounded-lg hover:bg-[#163d1c] disabled:opacity-50 disabled:cursor-not-allowed transition-colors flex items-center gap-1.5"
        >
          {creating ? (
            <>
              <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
              Creating…
            </>
          ) : (
            "Create project"
          )}
        </button>
      </div>
    </form>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

const ProjectList: FC<ProjectListProps> = ({ onOpenProject, onToast }) => {
  const { projects, loading, error, baseDir, setBaseDir, refresh } =
    useProjects();
  const [showNewProjectForm, setShowNewProjectForm] = useState(false);
  const [creating, setCreating] = useState(false);

  async function handleChangeFolder() {
    const selected = await open({ directory: true, multiple: false });
    if (!selected || typeof selected !== "string") return;
    const parts = selected.replace(/\\/g, "/").split("/");
    const leaf = parts[parts.length - 1];
    let finalDir: string;
    if (leaf === "AgCensus") {
      finalDir = selected;
    } else {
      const sep = selected.includes("\\") ? "\\" : "/";
      finalDir = `${selected.replace(/[/\\]+$/, "")}${sep}AgCensus`;
    }
    setBaseDir(finalDir);
  }

  async function handleCreateProject(data: NewProjectFormData) {
    if (!baseDir) {
      onToast("Set a project folder first.", "warning");
      return;
    }
    setCreating(true);
    try {
      const safeName = data.country
        .replace(/[^\w\s-]/g, "")
        .replace(/\s+/g, "-");
      const safeYear = data.referenceYear.replace(/\//g, "-");
      const projectDir = joinProjectPath(baseDir, `${safeName}-${safeYear}`);

      const manifest = JSON.stringify(
        {
          schema_version: "1.0",
          country: data.country,
          country_iso3: data.iso3.toUpperCase(),
          census_round: "WCA 2020",
          census_name: data.censusName,
          reference_year: data.referenceYear,
          reference_day: "day of interview",
          methodology_type: data.methodologyType,
          statistical_unit: data.statisticalUnit,
          lower_size_threshold: "",
          national_statistical_office: "",
          source_documents: [],
          compiled_by: "",
          compiled_at: new Date().toISOString(),
          app_version: "1.0.0",
        },
        null,
        2,
      );

      await invoke("create_project", { projectDir, manifest });
      onToast(
        `Project "${data.country} ${data.referenceYear}" created.`,
        "success",
      );
      setShowNewProjectForm(false);
      refresh();
    } catch (err) {
      onToast(`Failed to create project: ${String(err)}`, "error");
    } finally {
      setCreating(false);
    }
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
              Ag Census MR TMR Compiler
            </div>
            <div className="text-[10px] text-green-200 leading-tight">
              FAO WCA 2020
            </div>
          </div>
        </div>
        <div className="flex items-center gap-2">
          <button
            onClick={() => void handleChangeFolder()}
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
            onClick={() =>
              onToast("Import bundle is coming in a future session.", "info")
            }
            className="text-xs text-green-200 hover:text-white border border-green-700 hover:border-green-400 rounded px-2.5 py-1.5 transition-colors"
          >
            Import bundle
          </button>
          <button
            onClick={() => setShowNewProjectForm((v) => !v)}
            className={`text-xs font-semibold rounded px-3 py-1.5 transition-colors ${
              showNewProjectForm
                ? "bg-white/20 text-white border border-white/30"
                : "bg-white text-[#1B4F23] hover:bg-green-50"
            }`}
          >
            {showNewProjectForm ? "✕ Cancel" : "+ New project"}
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
        {/* Inline new-project form — shown above the project grid */}
        {showNewProjectForm && (
          <NewProjectForm
            onSubmit={handleCreateProject}
            onCancel={() => setShowNewProjectForm(false)}
            creating={creating}
          />
        )}

        {loading ? (
          <Spinner />
        ) : error ? (
          <ErrorState
            message={error}
            onRetry={() => void handleChangeFolder()}
          />
        ) : projects.length === 0 ? (
          <EmptyState
            baseDir={baseDir}
            onChangeDir={() => void handleChangeFolder()}
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

    </div>
  );
};

export default ProjectList;
