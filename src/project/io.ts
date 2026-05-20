/**
 * Async I/O for country project directories.
 *
 * Rules enforced here:
 *  - Every file operation uses fs/promises (no sync calls).
 *  - Every path is built with path.join() (no hardcoded separators).
 */

import {
  mkdir,
  readFile,
  writeFile,
  appendFile,
  readdir,
} from "node:fs/promises";
import path from "node:path";
import type {
  Manifest,
  SourceDocumentRef,
  SourceIndex,
  SourceIndexEntry,
  EvidenceIndex,
  PageJson,
  TableJson,
  ClaimsJson,
  CellsJson,
  AuditEvent,
  ProjectCreatedEvent,
  SourceAddedEvent,
} from "./schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

export const APP_VERSION = "1.0.0";
export const SCHEMA_VERSION = "1.0";

// ---------------------------------------------------------------------------
// Private helpers
// ---------------------------------------------------------------------------

function nowIso(): string {
  return new Date().toISOString();
}

function todayDate(): string {
  return new Date().toISOString().slice(0, 10); // "YYYY-MM-DD"
}

async function readJson<T>(filePath: string): Promise<T> {
  const raw = await readFile(filePath, "utf-8");
  return JSON.parse(raw) as T;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Path helpers (exported so tests and other modules can construct paths
// consistently without repeating the conventions)
// ---------------------------------------------------------------------------

export function manifestPath(projectDir: string): string {
  return path.join(projectDir, "manifest.json");
}

export function sourceIndexPath(projectDir: string): string {
  return path.join(projectDir, "sources", "_index.json");
}

export function evidenceIndexPath(projectDir: string): string {
  return path.join(projectDir, "evidence", "_evidence.json");
}

export function pagePath(projectDir: string, pageId: string): string {
  return path.join(projectDir, "evidence", "pages", `${pageId}.json`);
}

export function tablePath(projectDir: string, tableId: string): string {
  return path.join(projectDir, "evidence", "tables", `${tableId}.json`);
}

export function claimsPath(projectDir: string): string {
  return path.join(projectDir, "drafts", "mr", "_claims.json");
}

export function cellsPath(projectDir: string): string {
  return path.join(projectDir, "drafts", "tmr", "_cells.json");
}

export function auditFilePath(projectDir: string, date: string): string {
  return path.join(projectDir, "audit", `${date}-events.jsonl`);
}

// ---------------------------------------------------------------------------
// createProject
// ---------------------------------------------------------------------------

export interface CreateProjectFields {
  country: string;
  country_iso3: string;
  census_round: string;
  census_name: string;
  reference_year: string;
  reference_day: string;
  methodology_type: string;
  statistical_unit: string;
  lower_size_threshold: string;
  national_statistical_office: string;
  compiled_by: string;
}

/**
 * Initialise a new country project directory with the canonical layout
 * defined in DESIGN.md §4.  Throws if projectDir already exists unless
 * mkdir({recursive:true}) is called — in that case an existing directory is
 * silently re-used, which lets callers pre-create the path.
 */
export async function createProject(
  projectDir: string,
  fields: CreateProjectFields,
): Promise<void> {
  // Create all directories (recursive so intermediate parents are made too)
  await mkdir(path.join(projectDir, "sources"), { recursive: true });
  await mkdir(path.join(projectDir, "evidence", "pages"), { recursive: true });
  await mkdir(path.join(projectDir, "evidence", "tables"), {
    recursive: true,
  });
  await mkdir(path.join(projectDir, "drafts", "mr", "history"), {
    recursive: true,
  });
  await mkdir(path.join(projectDir, "drafts", "tmr", "history"), {
    recursive: true,
  });
  await mkdir(path.join(projectDir, "audit"), { recursive: true });

  // Write manifest.json
  const compiledAt = nowIso();
  const manifest: Manifest = {
    schema_version: SCHEMA_VERSION,
    ...fields,
    source_documents: [],
    compiled_at: compiledAt,
    app_version: APP_VERSION,
  };
  await writeJson(manifestPath(projectDir), manifest);

  // Write empty sources/_index.json
  const emptyIndex: SourceIndex = [];
  await writeJson(sourceIndexPath(projectDir), emptyIndex);

  // Write empty evidence/_evidence.json
  const emptyEvidence: EvidenceIndex = {
    pages: [],
    tables: [],
    last_updated: compiledAt,
  };
  await writeJson(evidenceIndexPath(projectDir), emptyEvidence);

  // Write empty draft backbone files
  const emptyClaims: ClaimsJson = {};
  await writeJson(claimsPath(projectDir), emptyClaims);

  const emptyCells: CellsJson = {};
  await writeJson(cellsPath(projectDir), emptyCells);

  // Append project_created audit event — always the first entry
  const event: ProjectCreatedEvent = {
    type: "project_created",
    timestamp: compiledAt,
    country: fields.country,
    country_iso3: fields.country_iso3,
    census_year: fields.reference_year,
    compiled_by: fields.compiled_by,
  };
  await appendAuditEvent(projectDir, event);
}

// ---------------------------------------------------------------------------
// readManifest / writeManifest
// ---------------------------------------------------------------------------

export async function readManifest(projectDir: string): Promise<Manifest> {
  return readJson<Manifest>(manifestPath(projectDir));
}

export async function writeManifest(
  projectDir: string,
  manifest: Manifest,
): Promise<void> {
  await writeJson(manifestPath(projectDir), manifest);
}

// ---------------------------------------------------------------------------
// addSource
// ---------------------------------------------------------------------------

/**
 * Add a source document to the project.
 *
 * Updates both sources/_index.json (full entry with hash, page count, etc.)
 * and manifest.json (short SourceDocumentRef for the identity card).
 * Appends a source_added audit event.
 *
 * Throws if a source with the same id already exists.
 */
export async function addSource(
  projectDir: string,
  entry: SourceIndexEntry,
): Promise<void> {
  // --- update _index.json ---
  const index = await readJson<SourceIndex>(sourceIndexPath(projectDir));
  if (index.some((e) => e.id === entry.id)) {
    throw new Error(
      `Source "${entry.id}" already exists in sources/_index.json`,
    );
  }
  index.push(entry);
  await writeJson(sourceIndexPath(projectDir), index);

  // --- update manifest.source_documents ---
  const manifest = await readManifest(projectDir);
  const ref: SourceDocumentRef = {
    id: entry.id,
    title: entry.description, // description is the human-readable title
    url: entry.url,
    retrieved: entry.retrieved,
    language: entry.language,
  };
  manifest.source_documents.push(ref);
  await writeManifest(projectDir, manifest);

  // --- audit ---
  const event: SourceAddedEvent = {
    type: "source_added",
    timestamp: nowIso(),
    source_id: entry.id,
    filename: entry.filename,
    sha256: entry.sha256,
  };
  await appendAuditEvent(projectDir, event);
}

// ---------------------------------------------------------------------------
// Evidence index
// ---------------------------------------------------------------------------

export async function readEvidence(projectDir: string): Promise<EvidenceIndex> {
  return readJson<EvidenceIndex>(evidenceIndexPath(projectDir));
}

export async function writeEvidence(
  projectDir: string,
  index: EvidenceIndex,
): Promise<void> {
  await writeJson(evidenceIndexPath(projectDir), index);
}

// ---------------------------------------------------------------------------
// Individual page / table evidence files
// ---------------------------------------------------------------------------

export async function readPage(
  projectDir: string,
  pageId: string,
): Promise<PageJson> {
  return readJson<PageJson>(pagePath(projectDir, pageId));
}

export async function writePage(
  projectDir: string,
  page: PageJson,
): Promise<void> {
  await writeJson(pagePath(projectDir, page.page_id), page);
}

export async function readTable(
  projectDir: string,
  tableId: string,
): Promise<TableJson> {
  return readJson<TableJson>(tablePath(projectDir, tableId));
}

export async function writeTable(
  projectDir: string,
  table: TableJson,
): Promise<void> {
  await writeJson(tablePath(projectDir, table.table_id), table);
}

// ---------------------------------------------------------------------------
// Claims and cells
// ---------------------------------------------------------------------------

export async function readClaims(projectDir: string): Promise<ClaimsJson> {
  return readJson<ClaimsJson>(claimsPath(projectDir));
}

export async function writeClaims(
  projectDir: string,
  claims: ClaimsJson,
): Promise<void> {
  await writeJson(claimsPath(projectDir), claims);
}

export async function readCells(projectDir: string): Promise<CellsJson> {
  return readJson<CellsJson>(cellsPath(projectDir));
}

export async function writeCells(
  projectDir: string,
  cells: CellsJson,
): Promise<void> {
  await writeJson(cellsPath(projectDir), cells);
}

// ---------------------------------------------------------------------------
// Audit log
// ---------------------------------------------------------------------------

/**
 * Append one event to today's audit JSONL file.
 * Creates the file if it does not yet exist (appendFile behaviour).
 * The audit/ directory must already exist (created by createProject).
 */
export async function appendAuditEvent(
  projectDir: string,
  event: AuditEvent,
): Promise<void> {
  const filePath = auditFilePath(projectDir, todayDate());
  await appendFile(filePath, JSON.stringify(event) + "\n", "utf-8");
}

// ---------------------------------------------------------------------------
// Utility: list audit log files
// ---------------------------------------------------------------------------

/** Returns all JSONL filenames in audit/, sorted oldest-first by name. */
export async function listAuditFiles(projectDir: string): Promise<string[]> {
  const auditDir = path.join(projectDir, "audit");
  const entries = await readdir(auditDir);
  return entries.filter((f) => f.endsWith(".jsonl")).sort();
}
