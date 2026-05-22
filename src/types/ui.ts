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

/**
 * Total expected cells across all 23 WCA 2020 sub-tables.
 * Derived from src/concepts/wca-2020.json: sum of (rows × columns) per sub-table.
 * ST1:8, ST2:12, ST3:16, ST4:24, ST5:26, ST6:10, ST7:15, ST8:14, ST9:48,
 * ST10:6, ST11:14, ST12:12, ST13:44, ST14:10, ST15:8, ST16:10, ST17:18,
 * ST18:12, ST19:12, ST20:8, ST21:9, ST22:30, ST23:22  → total = 388
 */
export const TMR_CELLS_TOTAL = 388 as const;

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
  /** Always 15 (MR_SECTIONS_TOTAL) */
  mrSectionsTotal: number;
  /** Number of TMR sub-tables that have ≥1 populated numeric cell */
  tmrSubTablesOk: number;
  /** Always 23 (TMR_SUBTABLES_TOTAL) */
  tmrSubTablesTotal: number;
  /** Number of individual TMR cells with a numeric value */
  tmrCellsOk: number;
  /** Always 388 (TMR_CELLS_TOTAL) — total cells across all 23 sub-tables */
  tmrCellsTotal: number;
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
 * - parse_failed:  reserved for future detection
 */
export type SectionStatus = "ok" | "empty" | "not_generated" | "parse_failed";

/** Per-section summary displayed in the MR review screen. */
export interface SectionInfo {
  number: number;
  title: string;
  status: SectionStatus;
  claimCount: number;
  claims: Claim[];
  /** True when the Session 11 truncation_warning flag is present in _claims.json */
  truncatedWarning: boolean;
  /** True when a statistician has approved this section via approve_mr_section */
  approved: boolean;
}

// ---------------------------------------------------------------------------
// TMR sub-table review
// ---------------------------------------------------------------------------

/**
 * Status of a single TMR sub-table as derived from _cells.json.
 * - populated:     all expected cells have numeric values
 * - partial:       some cells numeric, some ".." / missing
 * - empty:         no cells have numeric values (all ".." or null)
 * - parse_failed:  parse_failed: true flag present in _cells.json entry
 * - not_generated: sub_table_N key absent from _cells.json
 */
export type SubTableStatus =
  | "populated"
  | "partial"
  | "empty"
  | "parse_failed"
  | "not_generated";

/** One cell as loaded from _cells.json, ready for display. */
export interface TmrCellDisplay {
  value: number | string | null;
  unit: string;
  derived: boolean;
  flags: string[];
  human_edited: boolean;
  /** True when the cited source_table_id did not exist on disk at generation time */
  unverified_source?: boolean;
  /** Unit conversion note, e.g. "acres to ha: 5000 * 0.4047 = 2023.5" */
  conversion?: string;
}

/** One validation rule failure stored in _cells.json under validation_flags. */
export interface ValidationFlagDisplay {
  rule: string;
  column: string;
  expected: number;
  actual: number;
  delta: number;
}

/** Per-sub-table summary displayed in the TMR review screen. */
export interface SubTableInfo {
  number: number;
  title: string;
  status: SubTableStatus;
  /** Number of cells with a numeric value */
  populatedCells: number;
  /** Total expected cells = spec.rows.length × Object.keys(spec.columns).length */
  totalCells: number;
  /** Validation rule failures recorded by the generator */
  validationFlags: ValidationFlagDisplay[];
  /** True when the generator's truncated: true flag is set in _cells.json */
  truncatedWarning: boolean;
  /** All cells keyed by canonical cell key (e.g. "Total_Holdings") */
  cells: Record<string, TmrCellDisplay>;
}

// ---------------------------------------------------------------------------
// Toast notifications
// ---------------------------------------------------------------------------

export interface ToastMessage {
  id: number;
  message: string;
  type: "info" | "success" | "error" | "warning";
}
