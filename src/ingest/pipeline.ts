/**
 * PDF ingestion pipeline.
 *
 * Orchestrates pdf.ts and tables.ts, then persists all results into the
 * project directory using the I/O helpers from src/project/io.ts.
 *
 * Steps:
 *   1. parsePdf()  → PageJson[]
 *   2. extractTables()  → TableJson[]
 *   3. Patch each PageJson.tables_on_page with the IDs of tables on that page.
 *   4. writePage() for every page.
 *   5. writeTable() for every table.
 *   6. Merge into evidence/_evidence.json and write.
 *   7. Append an evidence_indexed audit event.
 *
 * Constraints:
 *  - All paths use path.join() — no hardcoded separators.
 *  - All file I/O uses fs/promises — no sync calls.
 */

import {
  writePage,
  writeTable,
  readEvidence,
  writeEvidence,
  appendAuditEvent,
} from "../project/io";
import type {
  EvidencePageSummary,
  EvidenceTableSummary,
  EvidenceIndexedEvent,
} from "../project/schema";
import { parsePdf } from "./pdf";
import { extractTables } from "./tables";
import { parseExcel } from "./excel";

// ---------------------------------------------------------------------------
// Keyword extraction (simple: lowercase unique meaningful tokens)
// ---------------------------------------------------------------------------

/**
 * Extract a small set of keywords from a block of text.
 * Lowercases, splits on non-word characters, removes short tokens and
 * common English stop-words, returns up to 20 unique words.
 */
function extractKeywords(text: string): string[] {
  const STOP = new Set([
    "a", "an", "and", "are", "as", "at", "be", "been", "by", "for",
    "from", "has", "have", "in", "is", "it", "its", "of", "on", "or",
    "that", "the", "this", "to", "was", "were", "which", "with",
  ]);
  const words = text
    .toLowerCase()
    .split(/\W+/)
    .filter((w) => w.length >= 4 && !STOP.has(w));
  return [...new Set(words)].slice(0, 20);
}

// ---------------------------------------------------------------------------
// Public export
// ---------------------------------------------------------------------------

/**
 * Ingest one PDF into a project directory.
 *
 * @param projectDir   Absolute path to the project directory (must already
 *                     exist with the canonical layout from createProject()).
 * @param sourceDocId  The source document id (e.g. "01-main-report").
 * @param pdfPath      Absolute or relative path to the PDF file.
 * @param language     BCP-47 language tag (default "en").
 */
export async function ingestPdf(
  projectDir: string,
  sourceDocId: string,
  pdfPath: string,
  language = "en",
): Promise<void> {
  // 1. Parse PDF → pages
  const pages = await parsePdf(pdfPath, sourceDocId, language);

  // 2. Extract tables from the pages
  const tables = extractTables(pages, sourceDocId);

  // 3. Build a map: page_number → table IDs on that page, then patch pages
  const tablesByPage = new Map<number, string[]>();
  for (const table of tables) {
    const existing = tablesByPage.get(table.page_number) ?? [];
    existing.push(table.table_id);
    tablesByPage.set(table.page_number, existing);
  }

  for (const page of pages) {
    const ids = tablesByPage.get(page.page_number);
    if (ids && ids.length > 0) {
      page.tables_on_page = ids;
    }
  }

  // 4. Write individual page files
  for (const page of pages) {
    await writePage(projectDir, page);
  }

  // 5. Write individual table files
  for (const table of tables) {
    await writeTable(projectDir, table);
  }

  // 6. Merge into the evidence index
  const evidenceIndex = await readEvidence(projectDir);

  // Build a set of existing IDs so we don't add duplicates on re-ingest
  const existingPageIds = new Set(evidenceIndex.pages.map((p) => p.page_id));
  const existingTableIds = new Set(evidenceIndex.tables.map((t) => t.table_id));

  for (const page of pages) {
    if (!existingPageIds.has(page.page_id)) {
      const summary: EvidencePageSummary = {
        page_id: page.page_id,
        source_doc: page.source_doc,
        page_number: page.page_number,
        headings: page.headings,
        keywords: extractKeywords(page.text),
      };
      evidenceIndex.pages.push(summary);
    }
  }

  for (const table of tables) {
    if (!existingTableIds.has(table.table_id)) {
      const allText = [
        table.title,
        ...table.columns,
        ...table.rows.map((r) => r.label),
      ].join(" ");
      const summary: EvidenceTableSummary = {
        table_id: table.table_id,
        source_doc: table.source_doc,
        page_number: table.page_number,
        title: table.title,
        keywords: extractKeywords(allText),
      };
      evidenceIndex.tables.push(summary);
    }
  }

  evidenceIndex.last_updated = new Date().toISOString();
  await writeEvidence(projectDir, evidenceIndex);

  // 7. Append audit event
  const event: EvidenceIndexedEvent = {
    type: "evidence_indexed",
    timestamp: new Date().toISOString(),
    source_id: sourceDocId,
    pages_indexed: pages.length,
    tables_indexed: tables.length,
  };
  await appendAuditEvent(projectDir, event);
}

/**
 * Ingest one Excel workbook (.xlsx / .xls) into a project directory.
 *
 * Mirrors ingestPdf but uses the structured Excel parser: each sheet becomes
 * one TableJson and one PageJson. Writes them to the evidence store with the
 * same IO helpers, merges into evidence/_evidence.json, and appends an
 * evidence_indexed audit event.
 *
 * @param projectDir   Absolute path to the project directory.
 * @param sourceDocId  The source document id (e.g. "02-tables").
 * @param filePath     Absolute or relative path to the .xlsx / .xls file.
 * @param language     BCP-47 language tag (default "en").
 */
export async function ingestExcel(
  projectDir: string,
  sourceDocId: string,
  filePath: string,
  language = "en",
): Promise<void> {
  // 1. Parse workbook → pages (one per sheet) + tables (one per sheet)
  const { pages, tables } = await parseExcel(filePath, sourceDocId, language);

  // 2. Write individual page files
  for (const page of pages) {
    await writePage(projectDir, page);
  }

  // 3. Write individual table files
  for (const table of tables) {
    await writeTable(projectDir, table);
  }

  // 4. Merge into the evidence index (dedupe on id for safe re-ingest)
  const evidenceIndex = await readEvidence(projectDir);
  const existingPageIds = new Set(evidenceIndex.pages.map((p) => p.page_id));
  const existingTableIds = new Set(evidenceIndex.tables.map((t) => t.table_id));

  for (const page of pages) {
    if (!existingPageIds.has(page.page_id)) {
      const summary: EvidencePageSummary = {
        page_id: page.page_id,
        source_doc: page.source_doc,
        page_number: page.page_number,
        headings: page.headings,
        keywords: extractKeywords(page.text),
      };
      evidenceIndex.pages.push(summary);
    }
  }

  for (const table of tables) {
    if (!existingTableIds.has(table.table_id)) {
      const allText = [
        table.title,
        ...table.columns,
        ...table.rows.map((r) => r.label),
      ].join(" ");
      const summary: EvidenceTableSummary = {
        table_id: table.table_id,
        source_doc: table.source_doc,
        page_number: table.page_number,
        title: table.title,
        keywords: extractKeywords(allText),
      };
      evidenceIndex.tables.push(summary);
    }
  }

  evidenceIndex.last_updated = new Date().toISOString();
  await writeEvidence(projectDir, evidenceIndex);

  // 5. Append audit event
  const event: EvidenceIndexedEvent = {
    type: "evidence_indexed",
    timestamp: new Date().toISOString(),
    source_id: sourceDocId,
    pages_indexed: pages.length,
    tables_indexed: tables.length,
  };
  await appendAuditEvent(projectDir, event);
}
