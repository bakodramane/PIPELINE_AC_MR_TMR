/**
 * Screen — Audit log viewer.
 *
 * Shows a chronological list of all audit events from the project's
 * `audit/*.jsonl` files.  Events are loaded via Tauri's fs plugin
 * (readDir + readTextFile) and displayed newest-first by default.
 *
 * Event type colour coding:
 *   generation  → blue   (generation_started, generation_completed)
 *   edit        → yellow (section_edited, cell_edited)
 *   approval    → green  (certified_gold_standard)
 *   export      → purple (export)
 *   ingest      → grey   (project_created, source_added, evidence_indexed)
 *   flag        → orange (flag_raised, flag_resolved)
 *
 * Session 17: Initial implementation.
 */

import { useState, useEffect, type FC } from "react";
import { readDir, readTextFile } from "@tauri-apps/plugin-fs";
import { invoke } from "@tauri-apps/api/core";
import type { AuditEvent, AuditEventType } from "../project/schema";
import type { ToastMessage } from "../types/ui";

// ---------------------------------------------------------------------------
// Props
// ---------------------------------------------------------------------------

interface AuditLogProps {
  projectDir: string;
  projectName: string;
  onBack: () => void;
  onToast: (msg: string, type: ToastMessage["type"]) => void;
}

// ---------------------------------------------------------------------------
// Path helper
// ---------------------------------------------------------------------------

function joinPath(...parts: string[]): string {
  return parts.map((p) => p.replace(/[/\\]+$/, "")).join("/");
}

// ---------------------------------------------------------------------------
// Timestamp formatter  →  "22 May 2026 14:32"
// ---------------------------------------------------------------------------

const MONTHS = [
  "Jan","Feb","Mar","Apr","May","Jun",
  "Jul","Aug","Sep","Oct","Nov","Dec",
];

function formatTimestamp(iso: string): string {
  try {
    const d = new Date(iso);
    const dd = d.getDate().toString().padStart(2, "0");
    const mmm = MONTHS[d.getMonth()] ?? "?";
    const yyyy = d.getFullYear();
    const hh = d.getHours().toString().padStart(2, "0");
    const mm = d.getMinutes().toString().padStart(2, "0");
    return `${dd} ${mmm} ${yyyy} ${hh}:${mm}`;
  } catch {
    return iso;
  }
}

// ---------------------------------------------------------------------------
// Event type → display category
// ---------------------------------------------------------------------------

type EventCategory =
  | "generation"
  | "edit"
  | "approval"
  | "export"
  | "ingest"
  | "flag";

function getCategory(type: AuditEventType): EventCategory {
  switch (type) {
    case "generation_started":
    case "generation_completed":
      return "generation";
    case "section_edited":
    case "cell_edited":
      return "edit";
    case "certified_gold_standard":
      return "approval";
    case "export":
      return "export";
    case "flag_raised":
    case "flag_resolved":
      return "flag";
    default:
      return "ingest";
  }
}

const CATEGORY_STYLES: Record<
  EventCategory,
  { bg: string; text: string; border: string; label: string }
> = {
  generation: {
    bg: "bg-blue-50",
    text: "text-blue-700",
    border: "border-blue-200",
    label: "generation",
  },
  edit: {
    bg: "bg-yellow-50",
    text: "text-yellow-700",
    border: "border-yellow-200",
    label: "edit",
  },
  approval: {
    bg: "bg-emerald-50",
    text: "text-emerald-700",
    border: "border-emerald-200",
    label: "approval",
  },
  export: {
    bg: "bg-purple-50",
    text: "text-purple-700",
    border: "border-purple-200",
    label: "export",
  },
  ingest: {
    bg: "bg-gray-100",
    text: "text-gray-600",
    border: "border-gray-200",
    label: "ingest",
  },
  flag: {
    bg: "bg-orange-50",
    text: "text-orange-700",
    border: "border-orange-200",
    label: "flag",
  },
};

// ---------------------------------------------------------------------------
// Format target string (MR §n / TMR Tn)
// ---------------------------------------------------------------------------

function formatTarget(target: string, sectionOrTable: string): string {
  if (target === "mr") return `MR §${sectionOrTable}`;
  if (target === "tmr") return `TMR T${sectionOrTable}`;
  return sectionOrTable;
}

// ---------------------------------------------------------------------------
// Event detail lines
// ---------------------------------------------------------------------------

function EventDetails({ event }: { event: AuditEvent }) {
  const detailClass = "text-xs text-gray-500 leading-relaxed";

  switch (event.type) {
    case "generation_completed":
      return (
        <div className={detailClass}>
          <span className="font-medium text-gray-700">
            {formatTarget(event.target, event.section_or_table)}
          </span>
          {" · "}
          <span>{event.model}</span>
          {" · "}
          <span>{event.input_tokens.toLocaleString()} in</span>
          {" / "}
          <span>{event.output_tokens.toLocaleString()} out tokens</span>
          {" · "}
          <span className="text-green-700 font-medium">
            ${event.cost_usd.toFixed(4)}
          </span>
          {" · "}
          <span>{(event.wall_time_ms / 1000).toFixed(1)} s</span>
        </div>
      );

    case "generation_started":
      return (
        <div className={detailClass}>
          <span className="font-medium text-gray-700">
            {formatTarget(event.target, event.section_or_table)}
          </span>
          {" · "}
          <span>{event.model}</span>
          {" · "}
          <span className="italic">starting…</span>
        </div>
      );

    case "section_edited":
      return (
        <div className={detailClass}>
          Section{" "}
          <span className="font-medium text-gray-700">{event.section_id}</span>
          {" — "}claim{" "}
          <span className="font-mono">{event.claim_id}</span>
          {" (human_edited)"}
        </div>
      );

    case "cell_edited":
      return (
        <div className={detailClass}>
          <span className="font-medium text-gray-700">{event.table_key}</span>
          {" — "}
          <span className="font-mono">{event.cell_key}</span>
          {": "}
          <span className="text-red-500">
            {event.old_value !== null ? String(event.old_value) : "—"}
          </span>
          {" → "}
          <span className="text-green-700">
            {event.new_value !== null ? String(event.new_value) : "—"}
          </span>
        </div>
      );

    case "export":
      return (
        <div className={detailClass}>
          <span className="font-medium text-gray-700">{event.export_format.toUpperCase()}</span>
          {" — "}
          <span className="font-mono text-[11px]">
            {event.destination.split(/[/\\]/).pop() ?? event.destination}
          </span>
        </div>
      );

    case "source_added":
      return (
        <div className={detailClass}>
          <span className="font-mono">{event.filename}</span>
          {" ("}
          <span className="font-mono text-[10px]">{event.sha256.slice(0, 12)}…</span>
          {")"}
        </div>
      );

    case "evidence_indexed":
      return (
        <div className={detailClass}>
          <span className="font-medium text-gray-700">{event.source_id}</span>
          {" — "}
          <span>{event.pages_indexed} pages</span>
          {", "}
          <span>{event.tables_indexed} tables</span>
        </div>
      );

    case "project_created":
      return (
        <div className={detailClass}>
          <span className="font-medium text-gray-700">{event.country}</span>
          {" "}({event.country_iso3}){" · "}
          <span>{event.census_year}</span>
          {" · compiled by "}
          <span>{event.compiled_by}</span>
        </div>
      );

    case "certified_gold_standard":
      return (
        <div className={detailClass}>
          <span>Certified by </span>
          <span className="font-medium text-gray-700">{event.certifier}</span>
          {": "}
          <span className="italic">{event.rationale}</span>
        </div>
      );

    case "flag_raised":
      return (
        <div className={detailClass}>
          <span className="font-medium text-gray-700">{event.location}</span>
          {" — "}
          <span className="text-orange-600">⚑ {event.flag_label}</span>
        </div>
      );

    case "flag_resolved":
      return (
        <div className={detailClass}>
          <span className="font-medium text-gray-700">{event.location}</span>
          {" — "}
          <span className="text-green-700">✓ {event.flag_label}</span>
          {": "}
          <span>{event.resolution}</span>
        </div>
      );

    default:
      return null;
  }
}

// ---------------------------------------------------------------------------
// Event card
// ---------------------------------------------------------------------------

function EventCard({ event }: { event: AuditEvent }) {
  const category = getCategory(event.type);
  const style = CATEGORY_STYLES[category];

  return (
    <div className="bg-white border border-gray-200 rounded-lg px-4 py-3 space-y-1.5">
      <div className="flex items-center gap-2 flex-wrap">
        <span className="text-[10px] text-gray-400 tabular-nums font-mono shrink-0">
          {formatTimestamp(event.timestamp)}
        </span>
        <span
          className={`inline-flex items-center text-[10px] font-medium border px-1.5 py-0.5 rounded ${style.bg} ${style.text} ${style.border}`}
        >
          {style.label}
        </span>
        <span className="text-[11px] text-gray-500 font-mono">
          {event.type}
        </span>
      </div>
      <EventDetails event={event} />
    </div>
  );
}

// ---------------------------------------------------------------------------
// Main screen
// ---------------------------------------------------------------------------

const AuditLog: FC<AuditLogProps> = ({
  projectDir,
  projectName,
  onBack,
  onToast,
}) => {
  const [events, setEvents] = useState<AuditEvent[]>([]);
  const [loading, setLoading] = useState(true);
  const [newestFirst, setNewestFirst] = useState(true);
  const [mostRecentFile, setMostRecentFile] = useState<string | null>(null);

  // ── Load all JSONL files ──────────────────────────────────────────────────

  useEffect(() => {
    let cancelled = false;

    async function load() {
      setLoading(true);
      try {
        const auditDir = joinPath(projectDir, "audit");
        const entries = await readDir(auditDir);
        const jsonlFiles = entries
          .filter((e) => !e.isDirectory && e.name.endsWith(".jsonl"))
          .sort((a, b) => a.name.localeCompare(b.name)); // oldest first

        const allEvents: AuditEvent[] = [];
        for (const file of jsonlFiles) {
          const filePath = joinPath(auditDir, file.name);
          const raw = await readTextFile(filePath);
          for (const line of raw.split("\n")) {
            const trimmed = line.trim();
            if (!trimmed) continue;
            try {
              allEvents.push(JSON.parse(trimmed) as AuditEvent);
            } catch {
              // Skip malformed lines — e.g. partial writes
            }
          }
        }

        if (!cancelled) {
          setEvents(allEvents);
          if (jsonlFiles.length > 0) {
            setMostRecentFile(
              joinPath(auditDir, jsonlFiles[jsonlFiles.length - 1].name),
            );
          }
          setLoading(false);
        }
      } catch (err) {
        if (!cancelled) {
          onToast(`Failed to load audit log: ${String(err)}`, "error");
          setLoading(false);
        }
      }
    }

    void load();
    return () => {
      cancelled = true;
    };
  }, [projectDir]);

  // ── Sort events ───────────────────────────────────────────────────────────

  const sortedEvents = [...events].sort((a, b) =>
    newestFirst
      ? b.timestamp.localeCompare(a.timestamp)
      : a.timestamp.localeCompare(b.timestamp),
  );

  // ── Open most recent JSONL in default text editor ─────────────────────────

  async function handleDownload() {
    if (!mostRecentFile) {
      onToast("No audit log files found.", "info");
      return;
    }
    try {
      await invoke("open_path", { path: mostRecentFile });
    } catch (err) {
      onToast(`Failed to open file: ${String(err)}`, "error");
    }
  }

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
          <div className="flex-1">
            <div className="text-sm font-semibold leading-tight">
              {projectName}
            </div>
            <div className="text-[10px] text-green-200">Audit Log</div>
          </div>
          {/* Download full log */}
          <button
            onClick={() => void handleDownload()}
            disabled={!mostRecentFile}
            className={`flex items-center gap-2 text-xs font-medium px-3 py-2 rounded-lg border transition-colors ${
              !mostRecentFile
                ? "border-white/20 text-white/30 cursor-not-allowed"
                : "border-white/40 text-white/80 hover:bg-white/10 hover:border-white/60"
            }`}
          >
            ↓ Download full log
          </button>
        </div>
      </header>

      {/* Controls bar */}
      <div className="bg-white border-b border-gray-200 px-6 py-2">
        <div className="max-w-4xl mx-auto flex items-center justify-between">
          <div className="text-xs text-gray-500">
            {loading ? "Loading…" : `${events.length} event${events.length !== 1 ? "s" : ""}`}
          </div>
          <button
            onClick={() => setNewestFirst((v) => !v)}
            className="text-xs text-gray-500 border border-gray-200 rounded px-2 py-1 hover:border-gray-300 hover:text-gray-700 transition-colors"
          >
            {newestFirst ? "↓ Newest first" : "↑ Oldest first"}
          </button>
        </div>
      </div>

      {/* Event list */}
      <main className="max-w-4xl mx-auto px-6 py-6">
        {loading ? (
          <div className="flex items-center justify-center py-24">
            <div className="w-8 h-8 border-2 border-gray-200 border-t-[#1B4F23] rounded-full animate-spin" />
          </div>
        ) : sortedEvents.length === 0 ? (
          <div className="text-center py-24">
            <p className="text-gray-400 text-sm">
              No audit events found in{" "}
              <code className="font-mono text-[11px]">audit/</code>
            </p>
            <p className="text-gray-300 text-xs mt-1">
              Events are written automatically when sections are generated,
              edited, or exported.
            </p>
          </div>
        ) : (
          <div className="space-y-2">
            {sortedEvents.map((event, idx) => (
              <EventCard key={`${event.timestamp}-${idx}`} event={event} />
            ))}
          </div>
        )}
      </main>
    </div>
  );
};

export default AuditLog;
