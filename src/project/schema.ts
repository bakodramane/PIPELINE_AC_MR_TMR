/**
 * TypeScript types for every on-disk JSON shape defined in DESIGN.md §4.
 * Nothing is invented here beyond what the design specifies.
 */

// ---------------------------------------------------------------------------
// §4.1  manifest.json
// ---------------------------------------------------------------------------

/** One entry in manifest.source_documents */
export interface SourceDocumentRef {
  /** Matches the filename prefix, e.g. "01-main-report" */
  id: string;
  title: string;
  url: string;
  /** ISO 8601 date, e.g. "2026-05-18" */
  retrieved: string;
  /** BCP 47 language tag, e.g. "en" */
  language: string;
}

/** manifest.json — the identity card for a country project */
export interface Manifest {
  /** Always "1.0" for this spec */
  schema_version: string;
  country: string;
  /** ISO 3166-1 alpha-3, e.g. "NPL" */
  country_iso3: string;
  /** e.g. "WCA 2020" */
  census_round: string;
  /** Official local name of the census */
  census_name: string;
  /** e.g. "2021/2022" */
  reference_year: string;
  /** e.g. "day of interview" */
  reference_day: string;
  /** e.g. "sample-based" | "complete enumeration" */
  methodology_type: string;
  /** e.g. "agricultural holding" */
  statistical_unit: string;
  /** Plain-text lower size threshold definition */
  lower_size_threshold: string;
  /** Full name of the national statistics office */
  national_statistical_office: string;
  source_documents: SourceDocumentRef[];
  /** FAO email of the compiler */
  compiled_by: string;
  /** ISO 8601 datetime, set at project creation */
  compiled_at: string;
  /** Semver string of the app that created/last wrote this file */
  app_version: string;
}

// ---------------------------------------------------------------------------
// §4.2  sources/_index.json
// ---------------------------------------------------------------------------

/** One row in sources/_index.json — one per source file */
export interface SourceIndexEntry {
  /** Matches SourceDocumentRef.id and the filename prefix */
  id: string;
  /** Filename within sources/, e.g. "01-main-report.pdf" */
  filename: string;
  /** Origin URL the file was downloaded from */
  url: string;
  /** ISO 8601 date the file was retrieved */
  retrieved: string;
  /** SHA-256 hex digest of the file bytes */
  sha256: string;
  /** BCP 47 language tag */
  language: string;
  /** Populated for paginated documents (PDFs) */
  page_count?: number;
  /** Populated for tabular documents (HTML / CSV) */
  row_count?: number;
  /** One-line human description */
  description: string;
}

/** sources/_index.json — array of all source files */
export type SourceIndex = SourceIndexEntry[];

// ---------------------------------------------------------------------------
// §4.3  evidence/pages/*.json
// ---------------------------------------------------------------------------

/** evidence/pages/<page_id>.json */
export interface PageJson {
  /** e.g. "01-main-report-p014" */
  page_id: string;
  /** Foreign key to SourceIndexEntry.id */
  source_doc: string;
  page_number: number;
  /** Full extracted text of the page */
  text: string;
  /** Section headings detected on the page */
  headings: string[];
  /** IDs of tables that appear on this page */
  tables_on_page: string[];
  /** BCP 47 language tag */
  language: string;
  /**
   * 0–1 extraction confidence. Set by structured ingesters (e.g. Excel → 0.95).
   * Absent for plain PDF text pages (treated as high confidence by default).
   */
  extraction_confidence?: number;
  /**
   * Set to true by retrieveEvidence when this page was returned as a
   * keyword-independent fallback (no pages matched the query). Lets the
   * generator note in the audit log that fallback evidence was used.
   */
  fallback?: boolean;
}

// ---------------------------------------------------------------------------
// §4.3  evidence/tables/*.json
// ---------------------------------------------------------------------------

/** One data row inside a TableJson */
export interface TableRow {
  label: string;
  /** Numeric values aligned to TableJson.columns; null means missing/blank */
  values: (number | null)[];
}

/** evidence/tables/<table_id>.json */
export interface TableJson {
  /** e.g. "01-main-report-t023-livestock-by-type" */
  table_id: string;
  /** Foreign key to SourceIndexEntry.id */
  source_doc: string;
  page_number: number;
  title: string;
  /** Column headers; first entry may be empty string for the label column */
  columns: string[];
  rows: TableRow[];
  /** Maps column header → unit description */
  units: Record<string, string>;
  /** 0–1 float; low values indicate OCR or parse uncertainty */
  extraction_confidence: number;
}

// ---------------------------------------------------------------------------
// §4.3  evidence/_evidence.json  (the index)
// ---------------------------------------------------------------------------

/** Lightweight summary of a page kept in the evidence index */
export interface EvidencePageSummary {
  page_id: string;
  source_doc: string;
  page_number: number;
  headings: string[];
  /** Keywords extracted at index time for fast relevance matching */
  keywords: string[];
}

/** Lightweight summary of a table kept in the evidence index */
export interface EvidenceTableSummary {
  table_id: string;
  source_doc: string;
  page_number: number;
  title: string;
  /** Keywords extracted at index time for fast relevance matching */
  keywords: string[];
}

/** evidence/_evidence.json — the central lookup index */
export interface EvidenceIndex {
  pages: EvidencePageSummary[];
  tables: EvidenceTableSummary[];
  /** ISO 8601 datetime this index was last rebuilt */
  last_updated: string;
}

// ---------------------------------------------------------------------------
// §4.4  drafts/mr/_claims.json
// ---------------------------------------------------------------------------

/** Source citation for one claim */
export interface ClaimSource {
  /** Foreign key to PageJson.page_id */
  page_id: string;
  /** [start, end] byte offsets within PageJson.text */
  passage_offset: [number, number];
}

/** One claim within a MR section */
export interface Claim {
  /** e.g. "5.1", "5.2" */
  claim_id: string;
  /** The prose sentence */
  text: string;
  sources: ClaimSource[];
  /** Short labels for deviation flags, empty when none */
  deviation_flags: string[];
  /** True when a statistician has manually edited this claim */
  human_edited: boolean;
}

/** One section block inside _claims.json */
export interface SectionClaims {
  claims: Claim[];
}

/**
 * drafts/mr/_claims.json
 * Keys are section identifiers, e.g. "section_5".
 */
export type ClaimsJson = Record<string, SectionClaims>;

// ---------------------------------------------------------------------------
// §4.4  drafts/tmr/_cells.json
// ---------------------------------------------------------------------------

/** Source citation for one cell value */
export interface CellSource {
  /** Foreign key to TableJson.table_id */
  table_id: string;
  /** Row label within the source table */
  row: string;
  /** Column header within the source table */
  column: string;
}

/** One populated (or explicitly missing) cell in the TMR */
export interface Cell {
  /**
   * The cell value:
   * - number for a populated value
   * - string for WCA missing-value codes ("..", "…", "0", "*", "c")
   * - null when the cell has not yet been attempted
   */
  value: number | string | null;
  /** Unit string, e.g. "head", "ha" */
  unit: string;
  sources: CellSource[];
  /** True when the value was computed (unit conversion, subtotal) rather than directly read */
  derived: boolean;
  /** Short labels for any open flags on this cell */
  flags: string[];
  /** True when a statistician has manually edited this cell */
  human_edited: boolean;
}

/** One sub-table's cells, keyed by cell identifier, e.g. "cattle_head" */
export type CellTable = Record<string, Cell>;

/**
 * drafts/tmr/_cells.json
 * Keys are sub-table identifiers, e.g. "table_13_livestock_by_type".
 */
export type CellsJson = Record<string, CellTable>;

// ---------------------------------------------------------------------------
// §4.5  audit/<date>-events.jsonl
// ---------------------------------------------------------------------------

export type AuditEventType =
  | "project_created"
  | "source_added"
  | "evidence_indexed"
  | "generation_started"
  | "generation_completed"
  | "section_edited"
  | "cell_edited"
  | "flag_raised"
  | "flag_resolved"
  | "export"
  | "certified_gold_standard";

/** Fields common to every audit event */
interface BaseAuditEvent {
  type: AuditEventType;
  /** ISO 8601 datetime */
  timestamp: string;
}

export interface ProjectCreatedEvent extends BaseAuditEvent {
  type: "project_created";
  country: string;
  country_iso3: string;
  census_year: string;
  compiled_by: string;
}

export interface SourceAddedEvent extends BaseAuditEvent {
  type: "source_added";
  source_id: string;
  filename: string;
  sha256: string;
}

export interface EvidenceIndexedEvent extends BaseAuditEvent {
  type: "evidence_indexed";
  source_id: string;
  pages_indexed: number;
  tables_indexed: number;
}

export interface GenerationStartedEvent extends BaseAuditEvent {
  type: "generation_started";
  target: "mr" | "tmr" | "essential-items";
  section_or_table: string;
  prompt_version: string;
  model: string;
  provider: string;
}

export interface GenerationCompletedEvent extends BaseAuditEvent {
  type: "generation_completed";
  target: "mr" | "tmr" | "essential-items";
  section_or_table: string;
  prompt_version: string;
  model: string;
  provider: string;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
  wall_time_ms: number;
}

export interface SectionEditedEvent extends BaseAuditEvent {
  type: "section_edited";
  section_id: string;
  claim_id: string;
}

export interface CellEditedEvent extends BaseAuditEvent {
  type: "cell_edited";
  table_key: string;
  cell_key: string;
  old_value: number | string | null;
  new_value: number | string | null;
}

export interface FlagRaisedEvent extends BaseAuditEvent {
  type: "flag_raised";
  location: string;
  flag_label: string;
}

export interface FlagResolvedEvent extends BaseAuditEvent {
  type: "flag_resolved";
  location: string;
  flag_label: string;
  resolution: string;
}

export interface ExportEvent extends BaseAuditEvent {
  type: "export";
  export_format: string;
  destination: string;
}

export interface CertifiedGoldStandardEvent extends BaseAuditEvent {
  type: "certified_gold_standard";
  certifier: string;
  rationale: string;
  evidence_hash: string;
}

/** Discriminated union of all audit events */
export type AuditEvent =
  | ProjectCreatedEvent
  | SourceAddedEvent
  | EvidenceIndexedEvent
  | GenerationStartedEvent
  | GenerationCompletedEvent
  | SectionEditedEvent
  | CellEditedEvent
  | FlagRaisedEvent
  | FlagResolvedEvent
  | ExportEvent
  | CertifiedGoldStandardEvent;

// ---------------------------------------------------------------------------
// §4.6  certification/gold-standard.json
// ---------------------------------------------------------------------------

/** certification/gold-standard.json — only present for gold-standard projects */
export interface GoldStandard {
  certifier: string;
  /** ISO 8601 date */
  certified_at: string;
  rationale: string;
  /** SHA-256 hex digest of the evidence store at time of certification */
  evidence_hash: string;
}
