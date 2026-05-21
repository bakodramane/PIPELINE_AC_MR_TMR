/**
 * UI-specific types for the AgCensus Compiler frontend.
 *
 * These extend the project schema types with computed status fields that
 * are derived at load time and displayed in the React components.
 *
 * Do NOT import from src/project/io.ts here — that module uses Node.js APIs
 * (fs/promises, path) that cannot run in the Tauri webview.
 * Types from src/project/schema.ts are safe to import (types only, no runtime code).
 */

import type { Manifest, Claim } from "../project/schema";

// Re-export for convenience in components
export type { Manifest, Claim };

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const MR_SECTIONS_TOTAL = 15 as const;
export const TMR_SUBTABLES_TOTAL = 23 as const;

export const MR_SECTION_TITLES: Record<number, string> = {
  1: "Historical Outline",
  2: "Legal Basis and Organisation",
  3: "Reference Date and Period",
  4: "Enumeration Period",
  5: "Scope of the Census and Definition of the Statistical Unit",
  6: "Census Coverage",
  7: "Methodology",
  8: "Use of Technology",
  9: "Data Processing",
  10: "Quality Assurance",
  11: "Data and Metadata Archiving",
  12: "Data Reconciliation",
  13: "Dissemination of Census Results and Microdata",
  14: "Data Sources",
  15: "Contact",
};

// ---------------------------------------------------------------------------
// Project list
// ---------------------------------------------------------------------------

/** Computed summary of one country project, shown in the project list card. */
export interface ProjectInfo {
  /** Absolute path to the project directory */
  dir: string;
  manifest: Manifest;
  /** Number of MR sections that have ≥1 evidence-backed claim */
  mrSectionsOk: number;
  /** Always 15 (derived from MR_SECTIONS_TOTAL) */
  mrSectionsTotal: number;
  /** Number of TMR sub-tables that have ≥1 populated numeric cell */
  tmrSubTablesOk: number;
  /** Always 23 (derived from TMR_SUBTABLES_TOTAL) */
  tmrSubTablesTotal: number;
  /** ISO 8601 datetime from manifest.compiled_at */
  lastModified: string;
}

// ---------------------------------------------------------------------------
// MR section review
// ---------------------------------------------------------------------------

/**
 * Status of a single MR section as derived from _claims.json.
 * - ok:            section key exists with at least one claim
 * - empty:         section key exists with zero claims
 * - not_generated: section key absent from _claims.json
 * - parse_failed:  reserved for future detection (not yet surfaced from _claims.json)
 */
export type SectionStatus = "ok" | "empty" | "not_generated" | "parse_failed";

/** Per-section summary displayed in the MR review screen. */
export interface SectionInfo {
  number: number;
  title: string;
  status: SectionStatus;
  claimCount: number;
  claims: Claim[];
  /** True when the session 11 truncation_warning flag is present in _claims.json */
  truncatedWarning: boolean;
}

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------

export interface ToastMessage {
  id: number;
  message: string;
  type: "info" | "success" | "error" | "warning";
}
