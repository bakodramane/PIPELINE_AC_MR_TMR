/**
 * Screen 2 — MR section review.
 *
 * Shows all 15 Metadata Review sections for one country project.
 * Each section is a card with status badge + claim count; clicking expands
 * it to reveal the claims (evidence-backed prose sentences) and source refs.
 *
 * The "Generate all sections" button calls the Tauri `generate_mr_sections`
 * command — currently returns a user-friendly message pointing to the CLI
 * scripts (real wiring in Session 14).
 */

import { useState, useEffect, type FC } from "react";
import { readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type { ClaimsJson, Claim } from "../project/schema";
import {
  type SectionInfo,
  type SectionStatus,
  type ToastMessage,
  MR_SECTION_TITLES,
  MR_SECTIONS_TOTAL,
} from "../types/ui";

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
// Path helper
// ---------------------------------------------------------------------------

function joinPath(...parts: string[]): string {
  return parts.map((p) => p.replace(/[/\\]+$/, "")).join("/");
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

// ---------------------------------------------------------------------------
// Claim item
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
// Section card
// ---------------------------------------------------------------------------

function SectionCard({
  section,
  isExpanded,
  onToggle,
  onToast,
}: {
  section: SectionInfo;
  isExpanded: boolean;
  onToggle: () => void;
  onToast: (msg: string, type: ToastMessage["type"]) => void;
}) {
  const hasContent = section.claims.length > 0;

  return (
    <div
      className={`border rounded-lg overflow-hidden transition-shadow ${
        isExpanded ? "border-[#1B4F23] shadow-sm" : "border-gray-200"
      }`}
    >
      {/* Header row — always visible */}
      <button
        onClick={onToggle}
        className="w-full flex items-center gap-3 px-4 py-3 bg-white hover:bg-gray-50 text-left transition-colors"
      >
        {/* Section number */}
        <span className="text-xs font-mono text-gray-400 w-5 shrink-0">
          §{section.number}
        </span>

        {/* Title */}
        <span className="flex-1 text-sm font-medium text-gray-800 leading-tight">
          {section.title}
        </span>

        {/* Status + count */}
        <div className="flex items-center gap-2 shrink-0">
          {section.truncatedWarning && (
            <span
              className="text-[10px] text-orange-500"
              title="Model output was truncated"
            >
              ⚠
            </span>
          )}
          {hasContent && (
            <span className="text-xs text-gray-400 tabular-nums">
              {section.claimCount} claim{section.claimCount !== 1 ? "s" : ""}
            </span>
          )}
          <StatusBadge status={section.status} />
          <span className="text-gray-300 ml-1">
            {isExpanded ? "▲" : "▼"}
          </span>
        </div>
      </button>

      {/* Expanded body */}
      {isExpanded && (
        <div className="border-t border-gray-100 bg-gray-50 px-4 py-3">
          {section.status === "not_generated" ? (
            <p className="text-sm text-gray-400 italic">
              This section has not been generated yet. Run the CLI script or use
              the "Generate all sections" button above.
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

          {/* Action buttons */}
          <div className="mt-3 flex gap-2">
            <button
              onClick={() =>
                onToast("Claim editing is coming in Session 13.", "info")
              }
              className="text-xs text-gray-500 border border-gray-200 rounded px-3 py-1.5 hover:border-gray-300 hover:text-gray-700 transition-colors"
            >
              Edit claims
            </button>
            <button
              onClick={() => onToast("Section approved.", "success")}
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

const MrReview: FC<MrReviewProps> = ({
  projectDir,
  projectName,
  onBack,
  onSwitchToTmr,
  onToast,
}) => {
  const [sections, setSections] = useState<SectionInfo[]>([]);
  const [loadingClaims, setLoadingClaims] = useState(true);
  const [expandedSection, setExpandedSection] = useState<number | null>(null);
  const [generating, setGenerating] = useState(false);

  // ── Load _claims.json ────────────────────────────────────────────────────
  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoadingClaims(true);
      try {
        const claimsPath = joinPath(
          projectDir,
          "drafts",
          "mr",
          "_claims.json",
        );
        const raw = await readTextFile(claimsPath);
        const allClaims = JSON.parse(raw) as ClaimsJson;

        const loaded: SectionInfo[] = Array.from(
          { length: MR_SECTIONS_TOTAL },
          (_, idx) => {
            const num = idx + 1;
            const key = `section_${num}`;
            const sectionData = allClaims[key] as
              | (ClaimsJson[string] & { truncated_warning?: boolean })
              | undefined;

            let status: SectionStatus;
            let claims: Claim[] = [];
            let truncatedWarning = false;

            if (!sectionData) {
              status = "not_generated";
            } else {
              claims = sectionData.claims;
              truncatedWarning = sectionData.truncated_warning === true;
              status = claims.length > 0 ? "ok" : "empty";
            }

            return {
              number: num,
              title: MR_SECTION_TITLES[num] ?? `Section ${num}`,
              status,
              claimCount: claims.length,
              claims,
              truncatedWarning,
            };
          },
        );

        if (!cancelled) {
          setSections(loaded);
          setLoadingClaims(false);
        }
      } catch {
        if (!cancelled) {
          // File may not exist yet — show all sections as not_generated
          const empty: SectionInfo[] = Array.from(
            { length: MR_SECTIONS_TOTAL },
            (_, idx) => ({
              number: idx + 1,
              title: MR_SECTION_TITLES[idx + 1] ?? `Section ${idx + 1}`,
              status: "not_generated" as SectionStatus,
              claimCount: 0,
              claims: [],
              truncatedWarning: false,
            }),
          );
          setSections(empty);
          setLoadingClaims(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  // ── Generate all sections ────────────────────────────────────────────────
  async function handleGenerateAll() {
    setGenerating(true);
    try {
      await invoke<string>("generate_mr_sections", {
        projectDir,
        model: "deepseek-v4-flash",
      });
      onToast("Generation complete — reloading sections.", "success");
      // Trigger re-load by re-mounting (simplest approach for now)
      setLoadingClaims(true);
    } catch (err) {
      onToast(String(err), "warning");
    } finally {
      setGenerating(false);
    }
  }

  // ── Summary counts ───────────────────────────────────────────────────────
  const okCount = sections.filter((s) => s.status === "ok").length;
  const emptyCount = sections.filter((s) => s.status === "empty").length;
  const failedCount = sections.filter((s) => s.status === "parse_failed").length;
  const notRunCount = sections.filter((s) => s.status === "not_generated").length;

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
          <div className="flex-1">
            <div className="text-sm font-semibold leading-tight">
              {projectName}
            </div>
            <div className="text-[10px] text-green-200">
              Metadata Review Draft
            </div>
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
              />
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default MrReview;
