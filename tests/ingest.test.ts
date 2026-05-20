/**
 * End-to-end ingest pipeline test.
 *
 * Requires a real Nepal census PDF at:
 *   references/nepal-2021/sources/main-report.pdf
 * (relative to the project root)
 *
 * If the file is absent the suite is skipped with an explanatory message.
 * The test never tries to generate a fixture PDF — it is either present or not.
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { ingestPdf } from "../src/ingest/pipeline";
import { createProject } from "../src/project/io";
import { readEvidence, readPage, readTable } from "../src/project/io";

// ---------------------------------------------------------------------------
// Locate the real Nepal PDF (relative to the project root)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/**
 * Find the directory that contains the actual Nepal census PDF.
 *
 * Checks explicit candidates so the test works both when run from the project
 * root directly AND from inside a git worktree (which lives 3 levels deep
 * under the real project root at <project>/.claude/worktrees/<name>/).
 *
 * We search for the *specific file*, not just the `references/` folder,
 * because both the worktree and the real project root have a `references/`
 * directory but only the real one has the PDF inside it.
 */
const PDF_RELATIVE = path.join(
  "references",
  "nepal-2021",
  "sources",
  "main-report.pdf",
);

async function findProjectRoot(): Promise<string> {
  const candidates = [
    // 1. Worktree root (works if PDF was copied into the worktree)
    path.resolve(__dirname, ".."),
    // 2. Real project root when running from inside a git worktree:
    //    tests/ → <worktree> → worktrees/ → .claude/ → <project>
    path.resolve(__dirname, "..", "..", "..", ".."),
  ];

  for (const candidate of candidates) {
    try {
      await stat(path.join(candidate, PDF_RELATIVE));
      return candidate;
    } catch {
      // not found here — try next candidate
    }
  }

  return path.resolve(__dirname, "..");
}

const PROJECT_ROOT = await findProjectRoot();
const NEPAL_PDF = path.join(PROJECT_ROOT, PDF_RELATIVE);

const SOURCE_DOC_ID = "nepal-main-report";

// Minimal manifest fields needed for createProject
const FIELDS = {
  country: "Nepal",
  country_iso3: "NPL",
  census_round: "WCA 2020",
  census_name: "National Sample Census of Agriculture 2021/2022",
  reference_year: "2021/2022",
  reference_day: "day of interview",
  methodology_type: "sample-based",
  statistical_unit: "agricultural holding",
  lower_size_threshold: "0.01272 ha",
  national_statistical_office: "National Statistics Office (NSO), Nepal",
  compiled_by: "test@fao.org",
};

// ---------------------------------------------------------------------------
// Suite — skips cleanly when PDF is absent
// ---------------------------------------------------------------------------

describe("ingest pipeline (Nepal main report)", async () => {
  // Check PDF availability before the suite runs
  let pdfPresent = false;
  try {
    await stat(NEPAL_PDF);
    pdfPresent = true;
  } catch {
    console.warn(
      "\n[ingest.test.ts] SKIP — real Nepal census PDF not found at:\n" +
        `  ${NEPAL_PDF}\n` +
        "To run this test, place the Nepal 2021/2022 main report PDF at that path.\n",
    );
  }

  // Temporary project directory, created/destroyed around the test run
  let projectDir = "";

  beforeAll(async () => {
    if (!pdfPresent) return;
    projectDir = await mkdtemp(path.join(os.tmpdir(), "agcensus-ingest-test-"));
    await createProject(projectDir, FIELDS);
  });

  afterAll(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  it("ingestPdf completes without throwing", async (ctx) => {
    if (!pdfPresent) ctx.skip();
    await expect(
      ingestPdf(projectDir, SOURCE_DOC_ID, NEPAL_PDF),
    ).resolves.toBeUndefined();
  });

  it("produces at least 50 pages", async (ctx) => {
    if (!pdfPresent) ctx.skip();
    const evidence = await readEvidence(projectDir);
    expect(evidence.pages.length).toBeGreaterThanOrEqual(50);
  });

  it("every page in the index has a non-empty page_id and source_doc", async (ctx) => {
    if (!pdfPresent) ctx.skip();
    const evidence = await readEvidence(projectDir);
    for (const p of evidence.pages) {
      expect(p.page_id).toBeTruthy();
      expect(p.source_doc).toBe(SOURCE_DOC_ID);
    }
  });

  it("at least 80% of pages have non-empty text", async (ctx) => {
    if (!pdfPresent) ctx.skip();
    const evidence = await readEvidence(projectDir);
    // Sample first 20 and last 20 pages (census PDFs can have blank cover/back pages)
    const pageIds = evidence.pages.map((p) => p.page_id);
    const sampleIds = [...new Set([...pageIds.slice(0, 20), ...pageIds.slice(-20)])];
    let nonEmpty = 0;
    for (const pageId of sampleIds) {
      const page = await readPage(projectDir, pageId);
      if (page.text.trim().length > 0) nonEmpty++;
    }
    const ratio = nonEmpty / sampleIds.length;
    expect(ratio).toBeGreaterThanOrEqual(0.8);
  });

  it("produces at least 1 table", async (ctx) => {
    if (!pdfPresent) ctx.skip();
    const evidence = await readEvidence(projectDir);
    expect(evidence.tables.length).toBeGreaterThanOrEqual(1);
  });

  it("at least one table has ≥ 2 columns and ≥ 2 data rows", async (ctx) => {
    if (!pdfPresent) ctx.skip();
    const evidence = await readEvidence(projectDir);
    let found = false;
    for (const entry of evidence.tables) {
      const table = await readTable(projectDir, entry.table_id);
      if (table.columns.length >= 2 && table.rows.length >= 2) {
        found = true;
        break;
      }
    }
    expect(found).toBe(true);
  });

  it("tables_on_page is populated for pages that have tables", async (ctx) => {
    if (!pdfPresent) ctx.skip();
    const evidence = await readEvidence(projectDir);
    if (evidence.tables.length === 0) return;

    // Collect page numbers that host tables
    const tablePageNums = new Set(evidence.tables.map((t) => t.page_number));

    // Find those pages in evidence.pages and verify the page files have ids set
    let checkedAny = false;
    for (const pageSummary of evidence.pages) {
      if (tablePageNums.has(pageSummary.page_number)) {
        const page = await readPage(projectDir, pageSummary.page_id);
        expect(page.tables_on_page.length).toBeGreaterThan(0);
        checkedAny = true;
        break; // one is enough
      }
    }
    // If we found tables, we must have found a matching page
    expect(checkedAny).toBe(true);
  });

  it("evidence index last_updated is a valid ISO timestamp", async (ctx) => {
    if (!pdfPresent) ctx.skip();
    const evidence = await readEvidence(projectDir);
    const ts = new Date(evidence.last_updated);
    expect(Number.isNaN(ts.getTime())).toBe(false);
  });
});
