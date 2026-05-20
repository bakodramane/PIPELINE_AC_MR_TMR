/**
 * Nepal fixture — creates a minimal but structurally complete Nepal-2021
 * project directory on disk using the exact sample data from DESIGN.md §4.
 *
 * Usage:
 *   const dir = await mkdtemp(path.join(os.tmpdir(), 'agcensus-'));
 *   await createNepalFixture(dir);
 *   // dir now contains a valid Nepal-2021 project
 */

import {
  createProject,
  addSource,
  writePage,
  writeTable,
  writeEvidence,
  writeClaims,
  writeCells,
  appendAuditEvent,
} from "../../src/project/io";
import type {
  SourceIndexEntry,
  PageJson,
  TableJson,
  EvidenceIndex,
  ClaimsJson,
  CellsJson,
} from "../../src/project/schema";

// ---------------------------------------------------------------------------
// Manifest fields — drawn verbatim from DESIGN.md §4.1
// ---------------------------------------------------------------------------

export const NEPAL_FIELDS = {
  country: "Nepal",
  country_iso3: "NPL",
  census_round: "WCA 2020",
  census_name: "National Sample Census of Agriculture 2021/2022",
  reference_year: "2021/2022",
  reference_day: "day of interview",
  methodology_type: "sample-based",
  statistical_unit: "agricultural holding",
  lower_size_threshold:
    "0.01272 ha or 0.01355 ha or 1 head cattle/buffalo or 5 sheep/goats or 20 poultry",
  national_statistical_office: "National Statistics Office (NSO), Nepal",
  compiled_by: "a.statistician@fao.org",
} as const;

// ---------------------------------------------------------------------------
// Source document — drawn from DESIGN.md §4.1 and §4.2
// ---------------------------------------------------------------------------

export const NEPAL_SOURCE: SourceIndexEntry = {
  id: "01-main-report",
  filename: "01-main-report.pdf",
  url: "https://agricensusnepal.gov.np/main-report.pdf",
  retrieved: "2026-05-18",
  sha256:
    "a3f1c2e4b5d6a7b8c9d0e1f2a3b4c5d6e7f8a9b0c1d2e3f4a5b6c7d8e9f0a1b2",
  language: "en",
  page_count: 312,
  description: "NSCA 2021/2022 — Main Report",
};

// ---------------------------------------------------------------------------
// Page evidence — drawn verbatim from DESIGN.md §4.3
// ---------------------------------------------------------------------------

export const NEPAL_PAGE: PageJson = {
  page_id: "01-main-report-p014",
  source_doc: "01-main-report",
  page_number: 14,
  text: "Statistical unit. The statistical unit was the agricultural holding, defined as...",
  headings: [
    "5. Scope of the census and definition of the statistical unit",
  ],
  tables_on_page: ["01-main-report-t007"],
  language: "en",
};

// ---------------------------------------------------------------------------
// Table evidence — drawn verbatim from DESIGN.md §4.3
// ---------------------------------------------------------------------------

export const NEPAL_TABLE: TableJson = {
  table_id: "01-main-report-t023-livestock-by-type",
  source_doc: "01-main-report",
  page_number: 87,
  title: "Livestock, by type",
  columns: ["", "Holdings", "Head"],
  rows: [
    { label: "Cattle", values: [1708421, 4612472] },
    { label: "Buffalo", values: [1417028, 2923132] },
  ],
  units: { Holdings: "number of holdings", Head: "head" },
  extraction_confidence: 0.97,
};

// ---------------------------------------------------------------------------
// Evidence index
// ---------------------------------------------------------------------------

export const NEPAL_EVIDENCE_INDEX: EvidenceIndex = {
  pages: [
    {
      page_id: NEPAL_PAGE.page_id,
      source_doc: NEPAL_PAGE.source_doc,
      page_number: NEPAL_PAGE.page_number,
      headings: NEPAL_PAGE.headings,
      keywords: ["statistical unit", "agricultural holding", "scope", "census"],
    },
  ],
  tables: [
    {
      table_id: NEPAL_TABLE.table_id,
      source_doc: NEPAL_TABLE.source_doc,
      page_number: NEPAL_TABLE.page_number,
      title: NEPAL_TABLE.title,
      keywords: ["livestock", "cattle", "buffalo", "holdings", "head"],
    },
  ],
  last_updated: "2026-05-18T14:05:00Z",
};

// ---------------------------------------------------------------------------
// Claims — drawn verbatim from DESIGN.md §4.4
// ---------------------------------------------------------------------------

export const NEPAL_CLAIMS: ClaimsJson = {
  section_5: {
    claims: [
      {
        claim_id: "5.1",
        text: "The census scope mainly covers crop and livestock production activities.",
        sources: [
          {
            page_id: "01-main-report-p012",
            passage_offset: [148, 232],
          },
        ],
        deviation_flags: [],
        human_edited: false,
      },
    ],
  },
};

// ---------------------------------------------------------------------------
// Cells — drawn verbatim from DESIGN.md §4.4
// ---------------------------------------------------------------------------

export const NEPAL_CELLS: CellsJson = {
  table_13_livestock_by_type: {
    cattle_head: {
      value: 4612472,
      unit: "head",
      sources: [
        {
          table_id: "01-main-report-t023-livestock-by-type",
          row: "Cattle",
          column: "Head",
        },
      ],
      derived: false,
      flags: [],
      human_edited: false,
    },
  },
};

// ---------------------------------------------------------------------------
// createNepalFixture
// ---------------------------------------------------------------------------

/**
 * Populate `projectDir` with a complete minimal Nepal-2021 project that
 * satisfies every structural check in validateProject().
 *
 * The caller is responsible for creating and cleaning up the directory.
 */
export async function createNepalFixture(projectDir: string): Promise<void> {
  // 1. Scaffold directories and empty backbone files
  await createProject(projectDir, NEPAL_FIELDS);

  // 2. Register the source document
  await addSource(projectDir, NEPAL_SOURCE);

  // 3. Write page and table evidence files
  await writePage(projectDir, NEPAL_PAGE);
  await writeTable(projectDir, NEPAL_TABLE);

  // 4. Rebuild the evidence index to reflect those files
  await writeEvidence(projectDir, NEPAL_EVIDENCE_INDEX);

  // 5. Populate draft backbone files
  await writeClaims(projectDir, NEPAL_CLAIMS);
  await writeCells(projectDir, NEPAL_CELLS);

  // 6. Record an evidence_indexed audit event (simulating the parse pipeline)
  await appendAuditEvent(projectDir, {
    type: "evidence_indexed",
    timestamp: "2026-05-18T14:05:00Z",
    source_id: NEPAL_SOURCE.id,
    pages_indexed: 1,
    tables_indexed: 1,
  });
}
