/**
 * Screen — Project overview.
 *
 * Shown after clicking a project card in the project list.  Displays:
 *   - Four status metric cards (Sources, MR sections, TMR cells, Issues)
 *   - Two generator cards side-by-side (MR draft, TMR draft)
 *   - Navigation tab row (MR draft, TMR draft, Sources, Issues, Audit log)
 *
 * Session 19: Sources tab is now a real UI — lists indexed sources, provides
 * a drag-and-drop zone + native file picker (Tauri dialog plugin), and drives
 * the copy_source_file + ingest_source Tauri commands.
 */

import {
  useState,
  useEffect,
  useRef,
  useCallback,
  type FC,
} from "react";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import { open, save } from "@tauri-apps/plugin-dialog";
import { readTextFile } from "@tauri-apps/plugin-fs";
import type { ProjectInfo, ToastMessage } from "../types/ui";
import type { SourceIndexEntry } from "../project/schema";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface ProjectOverviewProps {
  project: ProjectInfo;
  onBack: () => void;
  onOpenMrReview: () => void;
  onOpenTmrReview: () => void;
  onOpenAuditLog: () => void;
  onToast: (msg: string, type: ToastMessage["type"]) => void;
}

// ---------------------------------------------------------------------------
// Path helper (same as in other screens)
// ---------------------------------------------------------------------------

function joinPath(...parts: string[]): string {
  return parts.map((p) => p.replace(/[/\\]+$/, "")).join("/");
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
  progress?: number;
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
      <div>
        <div className="text-sm font-semibold text-gray-900">{title}</div>
        <div className="text-[10px] text-gray-400 mt-0.5">{subtitle}</div>
      </div>

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
// Sources tab — types
// ---------------------------------------------------------------------------

type Language = "en" | "fr" | "es" | "ar" | "pt" | "other";

const LANGUAGE_OPTIONS: { value: Language; label: string }[] = [
  { value: "en", label: "English" },
  { value: "fr", label: "French" },
  { value: "es", label: "Spanish" },
  { value: "ar", label: "Arabic" },
  { value: "pt", label: "Portuguese" },
  { value: "other", label: "Other" },
];

interface IngestProgressPayload {
  doc_id: string;
  status: "done" | "error";
  page_count?: number;
  message?: string;
}

/** Source document types accepted by the ingest pipeline. */
const ACCEPTED_EXTENSIONS = ["pdf", "xlsx", "xls"];

/** True when a filename ends with one of the accepted source extensions. */
function hasAcceptedExtension(name: string): boolean {
  const lower = name.toLowerCase();
  return ACCEPTED_EXTENSIONS.some((ext) => lower.endsWith(`.${ext}`));
}

/** A file queued for ingestion. */
interface QueuedFile {
  path: string;
  name: string;
}

// ---------------------------------------------------------------------------
// Source row
// ---------------------------------------------------------------------------

function SourceRow({
  entry,
  onDelete,
}: {
  entry: SourceIndexEntry;
  onDelete: (id: string, filename: string) => void;
}) {
  const hasPages = (entry.page_count ?? 0) > 0;
  return (
    <div className="group flex items-center gap-3 bg-white border border-gray-200 rounded-lg px-3 py-2.5">
      <span className="text-base shrink-0">📄</span>
      <div className="flex-1 min-w-0">
        <div className="text-sm font-medium text-gray-800 truncate">
          {entry.filename}
        </div>
        <div className="text-[11px] text-gray-400 font-mono">{entry.id}</div>
      </div>
      <div className="shrink-0 text-xs text-gray-500 tabular-nums">
        {entry.page_count != null ? `${entry.page_count}p` : "—"}
      </div>
      <div className="shrink-0 text-xs text-gray-400 uppercase">
        {entry.language}
      </div>
      <div className="shrink-0 text-xs text-gray-400">{entry.retrieved}</div>
      <span
        className={`shrink-0 text-[11px] px-2 py-0.5 rounded-full border font-medium ${
          hasPages
            ? "bg-green-50 border-green-200 text-green-700"
            : "bg-amber-50 border-amber-200 text-amber-700"
        }`}
      >
        {hasPages ? "Indexed ✓" : "⚠ Low confidence"}
      </span>
      {/* Trash icon — visible only on row hover */}
      <button
        onClick={() => onDelete(entry.id, entry.filename)}
        title="Delete source"
        className="shrink-0 opacity-0 group-hover:opacity-100 transition-opacity text-red-400 hover:text-red-600 p-1 rounded"
      >
        <svg
          xmlns="http://www.w3.org/2000/svg"
          width="14"
          height="14"
          viewBox="0 0 24 24"
          fill="none"
          stroke="currentColor"
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        >
          <polyline points="3 6 5 6 21 6" />
          <path d="M19 6l-1 14H6L5 6" />
          <path d="M10 11v6" />
          <path d="M14 11v6" />
          <path d="M9 6V4h6v2" />
        </svg>
      </button>
    </div>
  );
}

// ---------------------------------------------------------------------------
// Sources tab — main component
// ---------------------------------------------------------------------------

function SourcesTab({
  projectDir,
  onToast,
  onSourcesCountChange,
}: {
  projectDir: string;
  onToast: (msg: string, type: ToastMessage["type"]) => void;
  onSourcesCountChange?: (count: number) => void;
}) {
  const [sources, setSources] = useState<SourceIndexEntry[]>([]);
  const [loading, setLoading] = useState(true);
  const [isDragOver, setIsDragOver] = useState(false);
  // Queue of files awaiting confirmation + ingestion. The user confirms the
  // Document ID + language for each file in sequence (one form at a time).
  const [queue, setQueue] = useState<QueuedFile[]>([]);
  const [queueIndex, setQueueIndex] = useState(0);
  const [docId, setDocId] = useState("");
  const [language, setLanguage] = useState<Language>("en");
  const [indexing, setIndexing] = useState(false);
  const [indexProgress, setIndexProgress] = useState<string | null>(null);
  const [confirmReplace, setConfirmReplace] = useState(false);
  // Delete confirmation state
  const [deleteTarget, setDeleteTarget] = useState<{ id: string; filename: string } | null>(null);
  const [deleting, setDeleting] = useState(false);

  // Default language for this project — persisted in localStorage so it is
  // remembered between sessions.  Applied to every file added to the queue.
  const langKey = `agcensus_lang_default_${projectDir}`;
  const [defaultLanguage, setDefaultLanguage] = useState<Language>(
    () => (localStorage.getItem(langKey) as Language | null) ?? "en",
  );

  function handleDefaultLanguageChange(lang: Language) {
    setDefaultLanguage(lang);
    localStorage.setItem(langKey, lang);
  }

  // Ref so the drag-drop event listener always sees current sources count
  const sourcesLengthRef = useRef(0);
  useEffect(() => {
    sourcesLengthRef.current = sources.length;
  }, [sources.length]);

  // Running tally across a multi-file batch (survives per-file re-renders).
  const batchResults = useRef<{ ok: number; fail: number; lastPages: number }>({
    ok: 0,
    fail: 0,
    lastPages: 0,
  });

  // ── Load _index.json ──────────────────────────────────────────────────────

  const loadSources = useCallback(async (): Promise<SourceIndexEntry[]> => {
    try {
      const raw = await readTextFile(
        joinPath(projectDir, "sources", "_index.json"),
      );
      const list = JSON.parse(raw) as SourceIndexEntry[];
      setSources(list);
      setLoading(false);
      onSourcesCountChange?.(list.length);
      return list;
    } catch {
      setSources([]);
      setLoading(false);
      onSourcesCountChange?.(0);
      return [];
    }
  }, [projectDir, onSourcesCountChange]);

  useEffect(() => {
    void loadSources();
  }, [loadSources]);

  // ── Pre-fill the Document ID + language for one file ───────────────────────

  const prefillForFile = useCallback(
    (fileName: string, baseCount?: number) => {
      const dot = fileName.lastIndexOf(".");
      const stem = dot > 0 ? fileName.slice(0, dot) : fileName;
      const sanitized = stem
        .replace(/[^a-z0-9-]/gi, "-")
        .replace(/-+/g, "-")
        .toLowerCase();
      const base = baseCount ?? sourcesLengthRef.current;
      const prefix = String(base + 1).padStart(2, "0");
      setDocId(`${prefix}-${sanitized}`);
      // Use the project default language instead of always "en"
      setLanguage(defaultLanguage);
      setConfirmReplace(false);
    },
    [defaultLanguage],
  );

  // ── Enqueue selected/dropped files (filters to accepted extensions) ────────

  const enqueueFiles = useCallback(
    (files: QueuedFile[]) => {
      const accepted = files.filter((f) => hasAcceptedExtension(f.name));
      if (accepted.length === 0) return;
      batchResults.current = { ok: 0, fail: 0, lastPages: 0 };
      setQueue(accepted);
      setQueueIndex(0);
      prefillForFile(accepted[0].name);
    },
    [prefillForFile],
  );

  // ── Listen for Tauri window-level drag-drop events (multiple files) ────────

  useEffect(() => {
    let unlisten: (() => void) | undefined;

    listen<{ paths?: string[] }>("tauri://drag-drop", (event) => {
      setIsDragOver(false);
      const paths = (event.payload.paths ?? []).filter((p) =>
        hasAcceptedExtension(p),
      );
      if (paths.length > 0) {
        enqueueFiles(
          paths.map((p) => ({ path: p, name: p.split(/[/\\]/).pop() ?? p })),
        );
      }
    })
      .then((fn) => {
        unlisten = fn;
      })
      .catch(() => {/* drag-drop unavailable — click-to-browse still works */});

    return () => {
      unlisten?.();
    };
  }, [enqueueFiles]);

  // ── Native file picker (multiple selection) ────────────────────────────────

  async function handleBrowseClick() {
    if (indexing || queue.length > 0) return;
    const selected = await open({
      multiple: true,
      filters: [
        { name: "Census documents", extensions: ["pdf", "xlsx", "xls"] },
      ],
    });
    if (!selected) return;
    const arr = Array.isArray(selected) ? selected : [selected];
    enqueueFiles(
      arr.map((p) => ({ path: p, name: p.split(/[/\\]/).pop() ?? p })),
    );
  }

  // ── Cancel the whole batch ─────────────────────────────────────────────────

  function cancelBatch() {
    setQueue([]);
    setQueueIndex(0);
    setDocId("");
    setLanguage("en");
    setConfirmReplace(false);
  }

  // ── Confirm + ingest the current file, then advance to the next ────────────

  async function handleAddCurrent() {
    const current = queue[queueIndex];
    if (!current || indexing) return;

    // First click on a duplicate ID shows the confirmation prompt
    if (sources.some((s) => s.id === docId) && !confirmReplace) {
      setConfirmReplace(true);
      return;
    }
    setConfirmReplace(false);

    const total = queue.length;
    const multi = total > 1;
    const thisDocId = docId;
    const thisLang = language;

    setIndexing(true);
    setIndexProgress(
      multi ? `Copying ${current.name}…` : "Copying file…",
    );

    let pageCountFromEvent: number | null = null;
    let errorFromEvent: string | null = null;

    const unlisten = await listen<IngestProgressPayload>(
      "ingest-progress",
      (event) => {
        if (event.payload.doc_id !== thisDocId) return;
        if (event.payload.status === "done") {
          pageCountFromEvent = event.payload.page_count ?? null;
        } else if (event.payload.status === "error") {
          errorFromEvent = event.payload.message ?? "Unknown error";
        }
      },
    );

    let succeeded = false;
    let postCount = sourcesLengthRef.current;

    try {
      // Step 1 — copy file into sources/
      const destPath = await invoke<string>("copy_source_file", {
        srcPath: current.path,
        projectDir,
        docId: thisDocId,
        filename: current.name,
      });

      setIndexProgress(
        multi
          ? `Indexing file ${queueIndex + 1} of ${total}: ${current.name}…`
          : "Indexing pages… this may take 30–60 seconds for a large document",
      );

      // Step 2 — run ingest pipeline (emits ingest-progress events)
      await invoke("ingest_source", {
        projectDir,
        docId: thisDocId,
        filePath: destPath,
        language: thisLang,
      });

      if (errorFromEvent) {
        throw new Error(errorFromEvent);
      }

      succeeded = true;
      const fresh = await loadSources();
      postCount = fresh.length;
      const entry = fresh.find((s) => s.id === thisDocId);
      batchResults.current.lastPages =
        entry?.page_count ?? pageCountFromEvent ?? 0;
    } catch (err) {
      // Per-file error: surface it but keep processing the rest of the batch.
      onToast(`${current.name} failed: ${String(err)}`, "error");
    } finally {
      unlisten();
    }

    if (succeeded) batchResults.current.ok += 1;
    else batchResults.current.fail += 1;

    // Advance to the next file, or finish the batch.
    const isLast = queueIndex + 1 >= total;
    if (!isLast) {
      const nextIndex = queueIndex + 1;
      setQueueIndex(nextIndex);
      prefillForFile(queue[nextIndex].name, postCount);
      setIndexing(false);
      setIndexProgress(null);
    } else {
      const { ok, fail, lastPages } = batchResults.current;
      const done = ok + fail;
      if (done <= 1) {
        if (ok === 1) {
          onToast(`Indexed successfully · ${lastPages} pages`, "success");
        }
        // single-file failure was already toasted above
      } else if (fail === 0) {
        onToast(`Indexed ${ok} documents successfully`, "success");
      } else {
        onToast(
          `Indexed ${ok} of ${done} — ${fail} failed (see details)`,
          "warning",
        );
      }
      cancelBatch();
      setIndexing(false);
      setIndexProgress(null);
    }
  }

  // ── Delete a source ───────────────────────────────────────────────────────

  async function handleDeleteConfirmed() {
    if (!deleteTarget || deleting) return;
    setDeleting(true);
    try {
      await invoke("delete_source", {
        projectDir,
        docId: deleteTarget.id,
      });
      setDeleteTarget(null);
      await loadSources();
      onToast("Source removed", "success");
    } catch (err) {
      onToast(`Delete failed: ${String(err)}`, "error");
    } finally {
      setDeleting(false);
    }
  }

  // ── Render ────────────────────────────────────────────────────────────────

  const current =
    queue.length > 0 && queueIndex < queue.length ? queue[queueIndex] : null;
  const isLastInQueue = queueIndex + 1 >= queue.length;

  return (
    <div className="px-6 py-5 space-y-4">
      {/* Source list */}
      {loading ? (
        <div className="flex items-center gap-2 py-4 text-xs text-gray-400">
          <div className="w-3 h-3 border border-gray-300 border-t-[#1B4F23] rounded-full animate-spin" />
          Loading sources…
        </div>
      ) : sources.length > 0 ? (
        <div className="space-y-2">
          <div className="text-xs font-medium text-gray-500 uppercase tracking-wider">
            Indexed sources ({sources.length})
          </div>
          {sources.map((entry) => (
            <SourceRow
              key={entry.id}
              entry={entry}
              onDelete={(id, filename) => setDeleteTarget({ id, filename })}
            />
          ))}
        </div>
      ) : (
        <p className="text-sm text-gray-400 italic">
          No source documents indexed yet.
        </p>
      )}

      {/* Default language selector — persisted per project */}
      <div className="flex items-center gap-3 py-1">
        <label className="text-xs text-gray-500 shrink-0">
          Default language
        </label>
        <select
          value={defaultLanguage}
          onChange={(e) =>
            handleDefaultLanguageChange(e.target.value as Language)
          }
          className="text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:border-[#1B4F23]"
        >
          {LANGUAGE_OPTIONS.map((o) => (
            <option key={o.value} value={o.value}>
              {o.label}
            </option>
          ))}
        </select>
        <span className="text-[11px] text-gray-400">
          Pre-fills language for each file you add
        </span>
      </div>

      {/* Drop zone — hidden while showing the form or while indexing */}
      {!current && !indexing && (
        <div
          onDragOver={(e) => {
            e.preventDefault();
            setIsDragOver(true);
          }}
          onDragLeave={() => setIsDragOver(false)}
          onDrop={(e) => {
            e.preventDefault();
            setIsDragOver(false);
          }}
          onClick={() => void handleBrowseClick()}
          className={`cursor-pointer border-2 border-dashed rounded-xl p-10 text-center transition-all select-none ${
            isDragOver
              ? "border-[#1B4F23] bg-green-50"
              : "border-gray-300 hover:border-gray-400 hover:bg-gray-50 bg-gray-50/50"
          }`}
        >
          <div className="text-3xl mb-2">📄</div>
          <div className="text-sm font-medium text-gray-700">
            Drop census documents here or click to browse
          </div>
          <div className="text-xs text-gray-400 mt-1">
            PDF, XLSX, or XLS files · multiple allowed
          </div>
        </div>
      )}

      {/* Inline form — shown when a file is awaiting confirmation, not indexing */}
      {current && !indexing && (
        <div className="border border-[#1B4F23]/40 rounded-xl p-4 bg-green-50/60 space-y-3">
          {queue.length > 1 && (
            <div className="text-xs text-[#1B4F23] font-medium">
              File {queueIndex + 1} of {queue.length}: {current.name} — confirm
              ID and language, then continue
            </div>
          )}
          <div className="flex items-center gap-2 text-sm font-medium text-gray-800">
            <span>📄</span>
            <span className="truncate">{current.name}</span>
          </div>

          <div className="grid grid-cols-1 sm:grid-cols-2 gap-3">
            <div className="space-y-1">
              <label className="block text-xs text-gray-500">Document ID</label>
              <input
                value={docId}
                onChange={(e) => {
                  setDocId(e.target.value);
                  setConfirmReplace(false);
                }}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:border-[#1B4F23]"
              />
            </div>

            <div className="space-y-1">
              <label className="block text-xs text-gray-500">Language</label>
              <select
                value={language}
                onChange={(e) => setLanguage(e.target.value as Language)}
                className="w-full text-sm border border-gray-200 rounded-lg px-3 py-1.5 bg-white focus:outline-none focus:border-[#1B4F23]"
              >
                {LANGUAGE_OPTIONS.map((o) => (
                  <option key={o.value} value={o.value}>
                    {o.label}
                  </option>
                ))}
              </select>
            </div>
          </div>

          {/* Duplicate-ID confirmation prompt */}
          {confirmReplace && (
            <div className="text-xs text-amber-800 bg-amber-50 border border-amber-200 rounded-lg px-3 py-2">
              A source with ID <code className="font-mono">"{docId}"</code>{" "}
              already exists. Click "Add and index" again to replace it.
            </div>
          )}

          <div className="flex gap-2">
            <button
              onClick={() => void handleAddCurrent()}
              className="text-xs font-medium text-white bg-[#1B4F23] rounded-lg px-4 py-2 hover:bg-[#163d1c] transition-colors"
            >
              {queue.length > 1 && !isLastInQueue
                ? "Add and continue"
                : "Add and index"}
            </button>
            <button
              onClick={cancelBatch}
              className="text-xs text-gray-500 border border-gray-200 rounded-lg px-3 py-2 hover:border-gray-300 hover:text-gray-700 transition-colors"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* Indexing progress */}
      {indexing && (
        <div className="border border-gray-200 rounded-xl p-4 bg-gray-50 flex items-center gap-3">
          <div className="w-4 h-4 border-2 border-[#1B4F23] border-t-transparent rounded-full animate-spin shrink-0" />
          <div className="text-sm text-gray-600">{indexProgress}</div>
        </div>
      )}

      {/* Delete confirmation overlay */}
      {deleteTarget && (
        <div className="fixed inset-0 bg-black/40 flex items-center justify-center z-50 p-4">
          <div className="bg-white rounded-xl shadow-xl w-full max-w-sm p-6 space-y-4">
            <h2 className="text-sm font-semibold text-gray-900">
              Delete {deleteTarget.filename}?
            </h2>
            <p className="text-xs text-gray-600">
              This will remove the file and all its indexed evidence. This
              cannot be undone.
            </p>
            <div className="flex gap-2 justify-end">
              <button
                onClick={() => setDeleteTarget(null)}
                disabled={deleting}
                className="text-xs border border-gray-200 rounded-lg px-4 py-2 text-gray-600 hover:border-gray-300 hover:text-gray-800 transition-colors disabled:opacity-50"
              >
                Cancel
              </button>
              <button
                onClick={() => void handleDeleteConfirmed()}
                disabled={deleting}
                className="text-xs bg-red-600 text-white rounded-lg px-4 py-2 hover:bg-red-700 transition-colors flex items-center gap-1.5 disabled:opacity-50"
              >
                {deleting ? (
                  <>
                    <div className="w-3 h-3 border border-white border-t-transparent rounded-full animate-spin" />
                    Deleting…
                  </>
                ) : (
                  "Delete"
                )}
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

type ActiveTab = "sources" | null;

const ProjectOverview: FC<ProjectOverviewProps> = ({
  project,
  onBack,
  onOpenMrReview,
  onOpenTmrReview,
  onOpenAuditLog,
  onToast,
}) => {
  const [mrGenerating, setMrGenerating] = useState(false);
  const [tmrGenerating, setTmrGenerating] = useState(false);
  const [activeTab, setActiveTab] = useState<ActiveTab>(null);
  const [exportingBundle, setExportingBundle] = useState(false);

  async function handleExportBundle() {
    const folderName =
      project.dir
        .replace(/[/\\]+$/, "")
        .split(/[/\\]/)
        .pop() ?? "project";

    const destPath = await save({
      filters: [{ name: "Ag Census bundle", extensions: ["zip"] }],
      defaultPath: `${folderName}.agcensus.zip`,
    });
    if (!destPath || typeof destPath !== "string") return;

    setExportingBundle(true);
    try {
      const savedPath = await invoke<string>("export_bundle", {
        projectDir: project.dir,
        destPath,
      });
      const filename = savedPath.split(/[/\\]/).pop() ?? savedPath;
      onToast(`Bundle exported: ${filename}`, "success");
    } catch (err) {
      onToast(`Export failed: ${String(err)}`, "error");
    } finally {
      setExportingBundle(false);
    }
  }

  const {
    manifest,
    mrSectionsOk,
    mrSectionsTotal,
    tmrSubTablesOk,
    tmrSubTablesTotal,
    tmrCellsOk,
    tmrCellsTotal,
  } = project;

  const [sourcesCount, setSourcesCount] = useState<number>(manifest.source_documents.length);

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
      subTableNumber: 0,
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
            <button
              onClick={() => void handleExportBundle()}
              disabled={exportingBundle}
              className="text-xs text-green-200 hover:text-white border border-green-700 hover:border-green-400 rounded px-2.5 py-1.5 transition-colors disabled:opacity-50 flex items-center gap-1"
              title="Export project as a shareable bundle"
            >
              {exportingBundle ? (
                <>
                  <div className="w-2.5 h-2.5 border border-green-300 border-t-transparent rounded-full animate-spin" />
                  Creating bundle…
                </>
              ) : (
                "↓ Export bundle"
              )}
            </button>
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

        {/* Navigation tabs + tab panel */}
        <div className="bg-white border border-gray-200 rounded-lg overflow-hidden">
          <div className="border-b border-gray-200 px-2 flex gap-0 overflow-x-auto">
            {/* Sources tab — first, styled with icon + badge */}
            <button
              onClick={() =>
                setActiveTab(activeTab === "sources" ? null : "sources")
              }
              className={`px-4 py-3 text-sm border-b-2 transition-colors whitespace-nowrap flex items-center gap-1.5 ${
                activeTab === "sources"
                  ? "border-[#1B4F23] text-[#1B4F23] font-medium"
                  : "border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 bg-[#1B4F23]/5"
              }`}
            >
              <span>📁</span>
              <span>Sources</span>
              {sourcesCount === 0 ? (
                <span className="w-2 h-2 rounded-full bg-amber-400 shrink-0" />
              ) : (
                <span className="text-[10px] text-green-600 font-semibold shrink-0">
                  ✓{sourcesCount}
                </span>
              )}
            </button>
            <NavTab label="MR draft" onClick={onOpenMrReview} />
            <NavTab label="TMR draft" onClick={onOpenTmrReview} />
            <NavTab
              label="Issues"
              onClick={() =>
                onToast("Issues queue — coming in a future session.", "info")
              }
            />
            <NavTab label="Audit log" onClick={onOpenAuditLog} />
          </div>

          {activeTab === "sources" ? (
            <SourcesTab
              projectDir={project.dir}
              onToast={onToast}
              onSourcesCountChange={setSourcesCount}
            />
          ) : (
            <div className="px-6 py-8 text-center">
              <p className="text-sm text-gray-400">
                Select a tab above to begin reviewing this project.
              </p>
            </div>
          )}
        </div>
      </main>
    </div>
  );
};

export default ProjectOverview;
