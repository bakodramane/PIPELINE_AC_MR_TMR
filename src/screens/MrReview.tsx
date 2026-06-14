/**
 * Screen — MR section review.
 *
 * Shows all 15 Metadata Review sections for one country project.
 * Each section is a card with status badge + claim count; clicking expands
 * it to reveal the claims (evidence-backed prose sentences) and source refs.
 *
 * Session 14: "Generate all sections" now calls the real Tauri
 * `generate_mr_sections` command via the shell plugin.  Progress events
 * ("generation-progress") stream back from Rust and each completed section
 * is reloaded from disk without a full-page refresh.
 *
 * Session 17: Inline claim editing via save_mr_section Tauri command.
 *             Section approval via approve_mr_section Tauri command.
 */

import { useState, useEffect, useCallback, useRef, type FC } from "react";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import { listen } from "@tauri-apps/api/event";
import type { ClaimsJson, Claim } from "../project/schema";
import {
  type SectionInfo,
  type SectionStatus,
  type ToastMessage,
  MR_SECTION_TITLES,
  MR_SECTIONS_TOTAL,
} from "../types/ui";
import { MODELS_BY_TIER, DEFAULT_MR_MODEL, getModelInfo } from "../providers/model-registry";
import type { Model } from "../providers/types";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface MrReviewProps {
  projectDir: string;
  projectName: string;
  onBack: () => void;
  onSwitchToTmr: () => void;
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
// Status badge
// ---------------------------------------------------------------------------

const STATUS_STYLES: Record<SectionStatus, { bg: string; text: string; label: string }> = {
  ok: {
    bg: "bg-green-100 border-green-200",
    text: "text-green-700",
    label: "✓ ok",
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

function StatusBadge({ status }: { status: SectionStatus }) {
  const s = STATUS_STYLES[status];
  return (
    <span
      className={`inline-flex items-center text-[11px] font-medium border px-2 py-0.5 rounded-full ${s.bg} ${s.text}`}
    >
      {s.label}
    </span>
  );
}

function ApprovedBadge() {
  return (
    <span className="inline-flex items-center text-[11px] font-medium border px-2 py-0.5 rounded-full bg-emerald-100 border-emerald-300 text-emerald-700">
      ✓ approved
    </span>
  );
}

// ---------------------------------------------------------------------------
// Auto-resize textarea
// ---------------------------------------------------------------------------

function AutoResizeTextarea({
  value,
  onChange,
  placeholder,
  className,
}: {
  value: string;
  onChange: (v: string) => void;
  placeholder?: string;
  className?: string;
}) {
  const ref = useRef<HTMLTextAreaElement>(null);

  useEffect(() => {
    if (ref.current) {
      ref.current.style.height = "auto";
      ref.current.style.height = `${ref.current.scrollHeight}px`;
    }
  }, [value]);

  return (
    <textarea
      ref={ref}
      value={value}
      onChange={(e) => onChange(e.target.value)}
      placeholder={placeholder}
      className={className}
      rows={1}
    />
  );
}

// ---------------------------------------------------------------------------
// Claim item (read-only view)
// ---------------------------------------------------------------------------

function ClaimItem({ claim }: { claim: Claim }) {
  return (
    <div className="py-2 border-b border-gray-100 last:border-0">
      <p className="text-sm text-gray-800 leading-relaxed">
        {claim.text}
        {claim.human_edited && (
          <span className="ml-2 text-[10px] bg-blue-50 border border-blue-200 text-blue-600 px-1.5 py-0.5 rounded font-medium">
            edited
          </span>
        )}
      </p>
      {claim.sources.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {claim.sources.map((src, i) => (
            <span
              key={i}
              className="text-[10px] bg-gray-100 text-gray-500 px-1.5 py-0.5 rounded font-mono"
            >
              {src.page_id}
            </span>
          ))}
        </div>
      )}
      {claim.deviation_flags.length > 0 && (
        <div className="mt-1 flex flex-wrap gap-1">
          {claim.deviation_flags.map((flag, i) => (
            <span
              key={i}
              className="text-[10px] bg-orange-50 border border-orange-200 text-orange-600 px-1.5 py-0.5 rounded"
            >
              ⚑ {flag}
            </span>
          ))}
        </div>
      )}
    </div>
  );
}

// ---------------------------------------------------------------------------
// Section card — with inline edit mode and approve button
// ---------------------------------------------------------------------------

function SectionCard({
  section,
  isExpanded,
  onToggle,
  onToast,
  projectDir,
  onSectionSaved,
  onSectionApproved,
}: {
  section: SectionInfo;
  isExpanded: boolean;
  onToggle: () => void;
  onToast: (msg: string, type: ToastMessage["type"]) => void;
  projectDir: string;
  onSectionSaved: (n: number) => Promise<void>;
  onSectionApproved: (n: number) => Promise<void>;
}) {
  const [editing, setEditing] = useState(false);
  const [editClaims, setEditClaims] = useState<Claim[]>([]);
  const [saving, setSaving] = useState(false);
  const [approving, setApproving] = useState(false);

  const hasContent = section.claims.length > 0;

  function enterEdit() {
    setEditClaims(section.claims.map((c) => ({ ...c })));
    setEditing(true);
  }

  function cancelEdit() {
    setEditing(false);
    setEditClaims([]);
  }

  function updateClaimText(idx: number, text: string) {
    setEditClaims((prev) =>
      prev.map((c, i) => (i === idx ? { ...c, text } : c)),
    );
  }

  function deleteClaim(idx: number) {
    setEditClaims((prev) => prev.filter((_, i) => i !== idx));
  }

  function addClaim() {
    const newClaim: Claim = {
      claim_id: `${section.number}.${editClaims.length + 1}`,
      text: "",
      sources: [],
      deviation_flags: [],
      human_edited: true,
    };
    setEditClaims((prev) => [...prev, newClaim]);
  }

  async function handleSave() {
    setSaving(true);
    try {
      // Mark every claim as human_edited on save
      const updatedClaims = editClaims.map((c) => ({
        ...c,
        human_edited: true,
      }));
      const sectionPayload = { claims: updatedClaims };
      await invoke("save_mr_section", {
        projectDir,
        sectionNumber: section.number,
        claimsJson: JSON.stringify(sectionPayload),
      });
      // Reload section from disk, THEN exit edit mode so UI shows fresh data
      await onSectionSaved(section.number);
      setEditing(false);
      setEditClaims([]);
      onToast(`§${section.number} saved.`, "success");
    } catch (err) {
      onToast(`Save failed: ${String(err)}`, "error");
    } finally {
      setSaving(false);
    }
  }

  async function handleApprove() {
    setApproving(true);
    try {
      await invoke("approve_mr_section", {
        projectDir,
        sectionNumber: section.number,
      });
      await onSectionApproved(section.number);
      onToast(`§${section.number} approved.`, "success");
    } catch (err) {
      onToast(`Approve failed: ${String(err)}`, "error");
    } finally {
      setApproving(false);
    }
  }

  return (
    <div
      className={`border rounded-lg overflow-hidden transition-shadow ${
        editing
          ? "border-blue-400 shadow-sm"
          : isExpanded
          ? "border-[#1B4F23] shadow-sm"
          : "border-gray-200"
      }`}
    >
      {/* Header row — clicking toggles expand; disabled while editing */}
      <button
        onClick={editing ? undefined : onToggle}
        className={`w-full flex items-center gap-3 px-4 py-3 bg-white text-left transition-colors ${
          editing ? "cursor-default" : "hover:bg-gray-50"
        }`}
      >
        <span className="text-xs font-mono text-gray-400 w-5 shrink-0">
          §{section.number}
        </span>
        <span className="flex-1 text-sm font-medium text-gray-800 leading-tight">
          {section.title}
        </span>
        <div className="flex items-center gap-2 shrink-0">
          {editing && (
            <span className="text-[11px] text-blue-600 font-medium">
              Editing
            </span>
          )}
          {section.truncatedWarning && !editing && (
            <span
              className="text-[10px] text-orange-500"
              title="Model output was truncated"
            >
              ⚠
            </span>
          )}
          {hasContent && !editing && (
            <span className="text-xs text-gray-400 tabular-nums">
              {section.claimCount} claim{section.claimCount !== 1 ? "s" : ""}
            </span>
          )}
          {section.approved && !editing && <ApprovedBadge />}
          {!editing && <StatusBadge status={section.status} />}
          {!editing && (
            <span className="text-gray-300 ml-1">
              {isExpanded ? "▲" : "▼"}
            </span>
          )}
        </div>
      </button>

      {/* ── Edit mode body ─────────────────────────────────────────────── */}
      {editing && (
        <div className="border-t border-gray-100 bg-gray-50 px-4 py-3 space-y-3">
          {editClaims.length === 0 && (
            <p className="text-sm text-gray-400 italic">
              No claims. Use "Add claim" below to add one.
            </p>
          )}

          {editClaims.map((claim, idx) => (
            <div
              key={claim.claim_id || idx}
              className="border border-gray-200 rounded-md bg-white p-3 space-y-2"
            >
              <div className="flex gap-2 items-start">
                <AutoResizeTextarea
                  value={claim.text}
                  onChange={(v) => updateClaimText(idx, v)}
                  placeholder="Enter claim text…"
                  className="flex-1 text-sm text-gray-800 border border-gray-200 rounded p-2 focus:border-blue-400 focus:outline-none resize-none min-h-[2.5rem] leading-relaxed"
                />
                <button
                  onClick={() => deleteClaim(idx)}
                  className="shrink-0 self-start text-xs text-red-500 hover:text-red-700 border border-red-200 rounded px-2 py-1 hover:bg-red-50 transition-colors"
                >
                  ✕ Delete
                </button>
              </div>

              {/* Source citations — shown as non-editable grey labels */}
              {claim.sources.length > 0 && (
                <div className="flex flex-wrap gap-1">
                  <span className="text-[10px] text-gray-400">Sources:</span>
                  {claim.sources.map((src, i) => (
                    <span
                      key={i}
                      className="text-[10px] bg-gray-100 text-gray-400 px-1.5 py-0.5 rounded font-mono border border-gray-200"
                      title="Source citation — not editable manually"
                    >
                      {src.page_id}
                    </span>
                  ))}
                </div>
              )}
            </div>
          ))}

          {/* Add claim */}
          <button
            onClick={addClaim}
            className="text-xs text-blue-600 border border-blue-200 rounded px-3 py-1.5 hover:bg-blue-50 transition-colors"
          >
            + Add claim
          </button>

          {/* Save / Cancel */}
          <div className="flex gap-2 pt-2 border-t border-gray-200">
            <button
              onClick={() => void handleSave()}
              disabled={saving}
              className={`text-xs text-white bg-[#1B4F23] rounded px-4 py-1.5 transition-colors ${
                saving
                  ? "opacity-60 cursor-not-allowed"
                  : "hover:bg-[#163d1c]"
              }`}
            >
              {saving ? "Saving…" : "Save"}
            </button>
            <button
              onClick={cancelEdit}
              disabled={saving}
              className="text-xs text-gray-500 border border-gray-200 rounded px-3 py-1.5 hover:border-gray-300 hover:text-gray-700 transition-colors disabled:opacity-50"
            >
              Cancel
            </button>
          </div>
        </div>
      )}

      {/* ── Normal expanded body ────────────────────────────────────────── */}
      {isExpanded && !editing && (
        <div className="border-t border-gray-100 bg-gray-50 px-4 py-3">
          {section.status === "not_generated" ? (
            <p className="text-sm text-gray-400 italic">
              This section has not been generated yet. Use the "Generate all
              sections" button above.
            </p>
          ) : section.status === "empty" ? (
            <p className="text-sm text-gray-400 italic">
              The model generated a response but no evidence-backed claims were
              extracted. The section may contain "not available" acknowledgements
              in <code className="text-xs">current.md</code>.
            </p>
          ) : section.status === "parse_failed" ? (
            <p className="text-sm text-red-500 italic">
              JSON parse failed — the model output was truncated or malformed.
              Check <code className="text-xs">drafts/mr/current.md</code> for
              the raw output.
            </p>
          ) : (
            <div>
              {section.claims.map((claim) => (
                <ClaimItem key={claim.claim_id} claim={claim} />
              ))}
            </div>
          )}

          <div className="mt-3 flex gap-2">
            <button
              onClick={enterEdit}
              className="text-xs text-gray-500 border border-gray-200 rounded px-3 py-1.5 hover:border-gray-300 hover:text-gray-700 transition-colors"
            >
              Edit claims
            </button>
            <button
              onClick={() => void handleApprove()}
              disabled={section.approved || approving}
              className={`text-xs text-white rounded px-3 py-1.5 transition-colors flex items-center gap-1.5 ${
                section.approved
                  ? "bg-emerald-700 opacity-60 cursor-not-allowed"
                  : approving
                  ? "bg-[#1B4F23] opacity-60 cursor-not-allowed"
                  : "bg-[#1B4F23] hover:bg-[#163d1c]"
              }`}
            >
              {approving ? (
                <>
                  <div className="w-2.5 h-2.5 border border-white border-t-transparent rounded-full animate-spin" />
                  Approving…
                </>
              ) : section.approved ? (
                <>✓ Approved</>
              ) : (
                <>✓ Approve</>
              )}
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

const MrReview: FC<MrReviewProps> = ({
  projectDir,
  projectName,
  onBack,
  onSwitchToTmr,
  onToast,
}) => {
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [loadingClaims, setLoadingClaims] = useState(true);
  const [sourcesCount, setSourcesCount] = useState<number | null>(null);
  const [expandedSection, setExpandedSection] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);
  const [genProgress, setGenProgress] = useState<{
    done: number;
    total: number;
  } | null>(null);
  // null  → not exporting; "mr" | "mr-docx" | "mr-clean" | "mr-docx-clean"
  const [exportingType, setExportingType] = useState<string | null>(null);
  // ISO 8601 timestamp of the most recent MR generation run, or "" if none
  const [lastRunAt, setLastRunAt] = useState<string>("");
  const [selectedModel, setSelectedModel] = useState<Model>(
    () =>
      (localStorage.getItem("agcensus_mr_model") as Model | null) ??
      DEFAULT_MR_MODEL,
  );

  // ── Load _claims.json ─────────────────────────────────────────────────────

  function buildSections(allClaims: ClaimsJson): SectionInfo[] {
    return Array.from({ length: MR_SECTIONS_TOTAL }, (_, idx) => {
      const num = idx + 1;
      const key = `section_${num}`;
      const sectionData = allClaims[key] as
        | (ClaimsJson[string] & {
            truncated_warning?: boolean;
            approved?: boolean;
          })
        | undefined;

      let status: SectionStatus;
      let claims: Claim[] = [];
      let truncatedWarning = false;
      let approved = false;

      if (!sectionData) {
        status = "not_generated";
      } else {
        claims = sectionData.claims;
        truncatedWarning = sectionData.truncated_warning === true;
        approved = sectionData.approved === true;
        status = claims.length > 0 ? "ok" : "empty";
      }

      return {
        number: num,
        title: MR_SECTION_TITLES[num] ?? `Section ${num}`,
        status,
        claimCount: claims.length,
        claims,
        truncatedWarning,
        approved,
      };
    });
  }

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoadingClaims(true);
      try {
        const claimsPath = joinPath(projectDir, "drafts", "mr", "_claims.json");
        const raw = await readTextFile(claimsPath);
        const allClaims = JSON.parse(raw) as ClaimsJson;
        if (!cancelled) {
          setSections(buildSections(allClaims));
          setLoadingClaims(false);
        }
      } catch {
        if (!cancelled) {
          setSections(
            Array.from({ length: MR_SECTIONS_TOTAL }, (_, idx) => ({
              number: idx + 1,
              title: MR_SECTION_TITLES[idx + 1] ?? `Section ${idx + 1}`,
              status: "not_generated" as SectionStatus,
              claimCount: 0,
              claims: [],
              truncatedWarning: false,
              approved: false,
            })),
          );
          setLoadingClaims(false);
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

  // ── Load last MR run timestamp from audit JSONL files ───────────────────

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
                event.target === "mr" &&
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

  // ── Reload a single section from disk ────────────────────────────────────

  const reloadSection = useCallback(
    async (n: number) => {
      try {
        const claimsPath = joinPath(projectDir, "drafts", "mr", "_claims.json");
        const raw = await readTextFile(claimsPath);
        const allClaims = JSON.parse(raw) as ClaimsJson;
        const key = `section_${n}`;
        const sectionData = allClaims[key] as
          | (ClaimsJson[string] & {
              truncated_warning?: boolean;
              approved?: boolean;
            })
          | undefined;

        let status: SectionStatus;
        let claims: Claim[] = [];
        let truncatedWarning = false;
        let approved = false;

        if (!sectionData) {
          status = "not_generated";
        } else {
          claims = sectionData.claims;
          truncatedWarning = sectionData.truncated_warning === true;
          approved = sectionData.approved === true;
          status = claims.length > 0 ? "ok" : "empty";
        }

        setSections((prev) =>
          prev.map((s) =>
            s.number === n
              ? {
                  number: n,
                  title: MR_SECTION_TITLES[n] ?? `Section ${n}`,
                  status,
                  claimCount: claims.length,
                  claims,
                  truncatedWarning,
                  approved,
                }
              : s,
          ),
        );
      } catch {
        // Reload failed — leave existing state
      }
    },
    [projectDir],
  );

  // ── Export (all four variants share one handler) ─────────────────────────
  //
  //   exportType: "mr"           → draft Markdown  (filename: …-draft.md)
  //   exportType: "mr-docx"      → draft Word       (filename: …-draft.docx)
  //   exportType: "mr-clean"     → approved-only MD (filename: ….md)
  //   exportType: "mr-docx-clean"→ approved-only DOCX (filename: ….docx)

  async function handleExport(exportType: string) {
    setExportingType(exportType);
    try {
      const outputPath = await invoke<string>("export_project", {
        projectDir,
        exportType,
      });
      const filename = outputPath.split(/[/\\]/).pop() ?? outputPath;
      onToast(`Exported to ${filename}`, "success");
    } catch (err) {
      onToast(`Export failed: ${String(err)}`, "error");
    } finally {
      setExportingType(null);
    }
  }

  // ── Generate all sections ─────────────────────────────────────────────────

  async function handleGenerateAll() {
    setGenerating(true);
    setGenProgress({ done: 0, total: MR_SECTIONS_TOTAL });

    // Set up listener BEFORE invoking so no events are missed
    const unlisten = await listen<GenerationProgressPayload>(
      "generation-progress",
      (event) => {
        const { type, number, status, message } = event.payload;
        if (type !== "mr") return;

        if (status === "done") {
          void reloadSection(number);
        } else {
          onToast(
            `§${number} failed: ${message ?? "unknown error"}`,
            "error",
          );
        }
        setGenProgress((prev) =>
          prev ? { ...prev, done: prev.done + 1 } : null,
        );
      },
    );

    try {
      const result = await invoke<string>("generate_mr_sections", {
        projectDir,
        model: selectedModel,
      });
      onToast(`Generation complete — ${result}.`, "success");
    } catch (err) {
      onToast(String(err), "error");
    } finally {
      unlisten();
      setGenerating(false);
      setGenProgress(null);
    }
  }

  // ── Summary counts ────────────────────────────────────────────────────────

  const okCount = sections.filter((s) => s.status === "ok").length;
  const emptyCount = sections.filter((s) => s.status === "empty").length;
  const failedCount = sections.filter((s) => s.status === "parse_failed").length;
  const notRunCount = sections.filter((s) => s.status === "not_generated").length;

  // ── Render ────────────────────────────────────────────────────────────────

  return (
    <div className="min-h-screen bg-gray-50">
      {/* Top bar */}
      <header className="bg-[#1B4F23] text-white px-6 py-4 sticky top-0 z-10 shadow-sm">
        <div className="max-w-4xl mx-auto flex items-center gap-4">
          <button
            onClick={onBack}
            className="text-green-200 hover:text-white transition-colors text-sm flex items-center gap-1"
          >
            ← Back
          </button>
          <div className="flex-1 min-w-0">
            <div className="text-sm font-semibold leading-tight truncate">
              {projectName}
            </div>
            <div className="text-[10px] text-green-200">
              Metadata Review Draft
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
          {/* Two export buttons: Draft DOCX · Clean DOCX */}
          <div className="flex items-center gap-1">
            {(["mr-docx", "mr-docx-clean"] as const).map(
              (type) => {
                const isThis   = exportingType === type;
                const disabled = exportingType !== null || generating;
                const label    =
                  type === "mr-docx" ? "↓ Draft DOCX" : "↓ Clean DOCX";
                return (
                  <button
                    key={type}
                    onClick={() => void handleExport(type)}
                    disabled={disabled}
                    className={`flex items-center gap-1.5 text-xs font-medium px-2.5 py-2 rounded-lg border transition-colors ${
                      disabled
                        ? "border-white/20 text-white/30 cursor-not-allowed"
                        : "border-white/40 text-white/80 hover:bg-white/10 hover:border-white/60"
                    }`}
                  >
                    {isThis ? (
                      <>
                        <div className="w-3 h-3 border border-white/40 border-t-transparent rounded-full animate-spin" />
                        Exporting…
                      </>
                    ) : (
                      label
                    )}
                  </button>
                );
              },
            )}
          </div>
          <button
            onClick={() => void handleGenerateAll()}
            disabled={generating}
            className={`flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg border transition-colors ${
              generating
                ? "border-green-600 text-green-300 cursor-not-allowed"
                : "border-green-500 text-green-100 hover:bg-white/10 hover:border-green-300"
            }`}
          >
            {generating ? (
              <>
                <div className="w-3 h-3 border border-green-300 border-t-transparent rounded-full animate-spin" />
                Generating…
              </>
            ) : (
              <>↻ Generate all sections</>
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
                localStorage.setItem("agcensus_mr_model", m);
              }}
              disabled={generating}
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
            // MR estimate: 15 sections × ~2 000 in + 400 out tokens
            const estIn  = 15 * 2_000;
            const estOut = 15 * 400;
            const estCost =
              (estIn * info.inputCostPerM + estOut * info.outputCostPerM) /
              1_000_000;
            return (
              <span className="text-[10px] text-green-400 shrink-0">
                Est. MR cost: ~${estCost.toFixed(3)} · 15 sections
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
      {generating && genProgress && (
        <div className="bg-[#1B4F23]/5 border-b border-[#1B4F23]/20 px-6 py-2">
          <div className="max-w-4xl mx-auto">
            <div className="flex items-center justify-between text-xs text-gray-600 mb-1.5">
              <span>Generating MR sections…</span>
              <span className="font-medium tabular-nums">
                {genProgress.done} / {genProgress.total}
              </span>
            </div>
            <div className="h-1.5 bg-gray-200 rounded-full overflow-hidden">
              <div
                className="h-full bg-[#1B4F23] rounded-full transition-all duration-300"
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
          <button className="px-4 py-3 text-sm border-b-2 border-[#1B4F23] text-[#1B4F23] font-medium">
            MR sections
          </button>
          <button
            onClick={onSwitchToTmr}
            className="px-4 py-3 text-sm border-b-2 border-transparent text-gray-500 hover:text-gray-700 hover:border-gray-300 transition-colors"
          >
            TMR sub-tables
          </button>
        </div>
      </div>

      {/* Status summary bar */}
      {!loadingClaims && sections.length > 0 && (
        <div className="bg-white border-b border-gray-200 px-6 py-2">
          <div className="max-w-4xl mx-auto flex items-center gap-4 text-xs">
            <span className="text-gray-500">MR sections:</span>
            <span className="text-green-600 font-medium">{okCount} ok</span>
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
            <span className="text-gray-400 font-mono text-[10px] truncate max-w-xs">
              {projectDir}
            </span>
          </div>
        </div>
      )}

      {/* Section list */}
      <main className="max-w-4xl mx-auto px-6 py-6">
        {loadingClaims ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 border-2 border-gray-200 border-t-[#1B4F23] rounded-full animate-spin" />
          </div>
        ) : (
          <div className="space-y-2">
            {sections.map((section) => (
              <SectionCard
                key={section.number}
                section={section}
                isExpanded={expandedSection === section.number}
                onToggle={() =>
                  setExpandedSection(
                    expandedSection === section.number
                      ? null
                      : section.number,
                  )
                }
                onToast={onToast}
                projectDir={projectDir}
                onSectionSaved={reloadSection}
                onSectionApproved={reloadSection}
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default MrReview;
