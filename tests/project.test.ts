/**
 * Unit tests for src/project/io.ts and src/project/validate.ts.
 *
 * Each test group gets its own temp directory created in beforeEach and
 * removed in afterEach — no test touches another test's files.
 */

import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtemp, rm, readFile, writeFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";

import {
  createProject,
  readManifest,
  writeManifest,
  addSource,
  readEvidence,
  writeEvidence,
  appendAuditEvent,
  readPage,
  writePage,
  readTable,
  writeTable,
  readClaims,
  writeClaims,
  readCells,
  writeCells,
  listAuditFiles,
  manifestPath,
  sourceIndexPath,
  evidenceIndexPath,
  claimsPath,
  cellsPath,
  auditFilePath,
  APP_VERSION,
  SCHEMA_VERSION,
} from "../src/project/io";
import { validateProject } from "../src/project/validate";
import type {
  Manifest,
  SourceIndexEntry,
  EvidenceIndex,
  PageJson,
  TableJson,
  ClaimsJson,
  CellsJson,
  AuditEvent,
} from "../src/project/schema";
import {
  createNepalFixture,
  NEPAL_FIELDS,
  NEPAL_SOURCE,
  NEPAL_PAGE,
  NEPAL_TABLE,
  NEPAL_EVIDENCE_INDEX,
  NEPAL_CLAIMS,
  NEPAL_CELLS,
} from "./fixtures/nepal-fixture";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function makeTmp(): Promise<string> {
  return mkdtemp(path.join(os.tmpdir(), "agcensus-test-"));
}

async function cleanTmp(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true });
}

async function fileExists(p: string): Promise<boolean> {
  try {
    await stat(p);
    return true;
  } catch {
    return false;
  }
}

async function dirExists(p: string): Promise<boolean> {
  try {
    const s = await stat(p);
    return s.isDirectory();
  } catch {
    return false;
  }
}

// ---------------------------------------------------------------------------
// createProject
// ---------------------------------------------------------------------------

describe("createProject", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createProject(dir, NEPAL_FIELDS);
  });
  afterEach(() => cleanTmp(dir));

  it("creates manifest.json with correct fields", async () => {
    const manifest = await readManifest(dir);
    expect(manifest.schema_version).toBe(SCHEMA_VERSION);
    expect(manifest.country).toBe("Nepal");
    expect(manifest.country_iso3).toBe("NPL");
    expect(manifest.census_round).toBe("WCA 2020");
    expect(manifest.compiled_by).toBe("a.statistician@fao.org");
    expect(manifest.app_version).toBe(APP_VERSION);
    expect(manifest.source_documents).toEqual([]);
    // compiled_at must be a parseable ISO datetime
    expect(() => new Date(manifest.compiled_at)).not.toThrow();
    expect(new Date(manifest.compiled_at).toISOString()).toBe(
      manifest.compiled_at,
    );
  });

  it("creates all required directories", async () => {
    await expect(dirExists(path.join(dir, "sources"))).resolves.toBe(true);
    await expect(
      dirExists(path.join(dir, "evidence", "pages")),
    ).resolves.toBe(true);
    await expect(
      dirExists(path.join(dir, "evidence", "tables")),
    ).resolves.toBe(true);
    await expect(
      dirExists(path.join(dir, "drafts", "mr", "history")),
    ).resolves.toBe(true);
    await expect(
      dirExists(path.join(dir, "drafts", "tmr", "history")),
    ).resolves.toBe(true);
    await expect(dirExists(path.join(dir, "audit"))).resolves.toBe(true);
  });

  it("creates sources/_index.json as an empty array", async () => {
    const raw = await readFile(sourceIndexPath(dir), "utf-8");
    expect(JSON.parse(raw)).toEqual([]);
  });

  it("creates evidence/_evidence.json with empty pages and tables", async () => {
    const index = await readEvidence(dir);
    expect(index.pages).toEqual([]);
    expect(index.tables).toEqual([]);
    expect(index.last_updated).toBeTruthy();
  });

  it("creates drafts/mr/_claims.json as an empty object", async () => {
    const claims = await readClaims(dir);
    expect(claims).toEqual({});
  });

  it("creates drafts/tmr/_cells.json as an empty object", async () => {
    const cells = await readCells(dir);
    expect(cells).toEqual({});
  });

  it("appends a project_created audit event", async () => {
    const files = await listAuditFiles(dir);
    expect(files.length).toBeGreaterThanOrEqual(1);

    const raw = await readFile(auditFilePath(dir, files[0].replace("-events.jsonl", "")), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    expect(lines.length).toBeGreaterThanOrEqual(1);

    const event = JSON.parse(lines[0]) as AuditEvent;
    expect(event.type).toBe("project_created");
    expect(event.timestamp).toBeTruthy();
    if (event.type === "project_created") {
      expect(event.country).toBe("Nepal");
      expect(event.country_iso3).toBe("NPL");
      expect(event.compiled_by).toBe("a.statistician@fao.org");
    }
  });
});

// ---------------------------------------------------------------------------
// readManifest / writeManifest round-trip
// ---------------------------------------------------------------------------

describe("readManifest / writeManifest", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createProject(dir, NEPAL_FIELDS);
  });
  afterEach(() => cleanTmp(dir));

  it("round-trips: write then read gives identical manifest", async () => {
    const original = await readManifest(dir);
    original.census_name = "Updated Census Name";
    await writeManifest(dir, original);

    const reread = await readManifest(dir);
    expect(reread.census_name).toBe("Updated Census Name");
    expect(reread.country).toBe(original.country);
    expect(reread.schema_version).toBe(original.schema_version);
  });

  it("throws a recognisable error when manifest.json is missing", async () => {
    // Remove the manifest
    const { unlink } = await import("node:fs/promises");
    await unlink(manifestPath(dir));

    await expect(readManifest(dir)).rejects.toThrow();
  });

  it("throws when manifest.json contains invalid JSON", async () => {
    await writeFile(manifestPath(dir), "{ not valid json }", "utf-8");
    await expect(readManifest(dir)).rejects.toThrow();
  });
});

// ---------------------------------------------------------------------------
// addSource
// ---------------------------------------------------------------------------

describe("addSource", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createProject(dir, NEPAL_FIELDS);
  });
  afterEach(() => cleanTmp(dir));

  it("appends the entry to sources/_index.json", async () => {
    await addSource(dir, NEPAL_SOURCE);

    const raw = await readFile(sourceIndexPath(dir), "utf-8");
    const index = JSON.parse(raw) as SourceIndexEntry[];
    expect(index).toHaveLength(1);
    expect(index[0].id).toBe("01-main-report");
    expect(index[0].sha256).toBe(NEPAL_SOURCE.sha256);
    expect(index[0].page_count).toBe(312);
  });

  it("adds a SourceDocumentRef to manifest.source_documents", async () => {
    await addSource(dir, NEPAL_SOURCE);

    const manifest = await readManifest(dir);
    expect(manifest.source_documents).toHaveLength(1);
    const ref = manifest.source_documents[0];
    expect(ref.id).toBe("01-main-report");
    expect(ref.url).toBe(NEPAL_SOURCE.url);
    expect(ref.language).toBe("en");
    // title is derived from description
    expect(ref.title).toBe(NEPAL_SOURCE.description);
  });

  it("appends a source_added audit event", async () => {
    await addSource(dir, NEPAL_SOURCE);

    const files = await listAuditFiles(dir);
    const auditDate = files[0].replace("-events.jsonl", "");
    const raw = await readFile(auditFilePath(dir, auditDate), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    const events = lines.map((l) => JSON.parse(l) as AuditEvent);
    const sourceEvent = events.find((e) => e.type === "source_added");
    expect(sourceEvent).toBeDefined();
    if (sourceEvent?.type === "source_added") {
      expect(sourceEvent.source_id).toBe("01-main-report");
      expect(sourceEvent.sha256).toBe(NEPAL_SOURCE.sha256);
    }
  });

  it("throws when adding a duplicate source id", async () => {
    await addSource(dir, NEPAL_SOURCE);
    await expect(addSource(dir, NEPAL_SOURCE)).rejects.toThrow(
      /already exists/,
    );
  });

  it("accumulates multiple sources correctly", async () => {
    const second: SourceIndexEntry = {
      ...NEPAL_SOURCE,
      id: "02-technical-report",
      filename: "02-technical-report.pdf",
      description: "NSCA 2021/2022 — Technical Report",
    };

    await addSource(dir, NEPAL_SOURCE);
    await addSource(dir, second);

    const raw = await readFile(sourceIndexPath(dir), "utf-8");
    const index = JSON.parse(raw) as SourceIndexEntry[];
    expect(index).toHaveLength(2);
    expect(index.map((e) => e.id)).toEqual([
      "01-main-report",
      "02-technical-report",
    ]);

    const manifest = await readManifest(dir);
    expect(manifest.source_documents).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// readEvidence / writeEvidence round-trip
// ---------------------------------------------------------------------------

describe("readEvidence / writeEvidence", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createProject(dir, NEPAL_FIELDS);
  });
  afterEach(() => cleanTmp(dir));

  it("round-trips: write then read gives identical EvidenceIndex", async () => {
    await writeEvidence(dir, NEPAL_EVIDENCE_INDEX);
    const result = await readEvidence(dir);

    expect(result.pages).toHaveLength(1);
    expect(result.pages[0].page_id).toBe("01-main-report-p014");
    expect(result.tables).toHaveLength(1);
    expect(result.tables[0].table_id).toBe(
      "01-main-report-t023-livestock-by-type",
    );
    expect(result.last_updated).toBe(NEPAL_EVIDENCE_INDEX.last_updated);
  });

  it("overwrites the index when called twice", async () => {
    await writeEvidence(dir, NEPAL_EVIDENCE_INDEX);
    await writeEvidence(dir, { pages: [], tables: [], last_updated: "2026-01-01T00:00:00Z" });

    const result = await readEvidence(dir);
    expect(result.pages).toHaveLength(0);
    expect(result.tables).toHaveLength(0);
  });
});

// ---------------------------------------------------------------------------
// Individual page / table evidence files
// ---------------------------------------------------------------------------

describe("writePage / readPage", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createProject(dir, NEPAL_FIELDS);
  });
  afterEach(() => cleanTmp(dir));

  it("round-trips a PageJson", async () => {
    await writePage(dir, NEPAL_PAGE);
    const result = await readPage(dir, NEPAL_PAGE.page_id);

    expect(result.page_id).toBe("01-main-report-p014");
    expect(result.page_number).toBe(14);
    expect(result.headings).toEqual(NEPAL_PAGE.headings);
    expect(result.tables_on_page).toEqual(["01-main-report-t007"]);
  });

  it("writes the file at the correct path", async () => {
    await writePage(dir, NEPAL_PAGE);
    const expectedPath = path.join(
      dir,
      "evidence",
      "pages",
      "01-main-report-p014.json",
    );
    await expect(fileExists(expectedPath)).resolves.toBe(true);
  });
});

describe("writeTable / readTable", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createProject(dir, NEPAL_FIELDS);
  });
  afterEach(() => cleanTmp(dir));

  it("round-trips a TableJson", async () => {
    await writeTable(dir, NEPAL_TABLE);
    const result = await readTable(dir, NEPAL_TABLE.table_id);

    expect(result.table_id).toBe("01-main-report-t023-livestock-by-type");
    expect(result.rows).toHaveLength(2);
    expect(result.rows[0].label).toBe("Cattle");
    expect(result.rows[0].values).toEqual([1708421, 4612472]);
    expect(result.extraction_confidence).toBe(0.97);
    expect(result.units).toEqual({
      Holdings: "number of holdings",
      Head: "head",
    });
  });
});

// ---------------------------------------------------------------------------
// Claims / Cells round-trip
// ---------------------------------------------------------------------------

describe("writeClaims / readClaims", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createProject(dir, NEPAL_FIELDS);
  });
  afterEach(() => cleanTmp(dir));

  it("round-trips ClaimsJson", async () => {
    await writeClaims(dir, NEPAL_CLAIMS);
    const result = await readClaims(dir);

    expect(result.section_5).toBeDefined();
    expect(result.section_5.claims).toHaveLength(1);
    const claim = result.section_5.claims[0];
    expect(claim.claim_id).toBe("5.1");
    expect(claim.sources[0].page_id).toBe("01-main-report-p012");
    expect(claim.sources[0].passage_offset).toEqual([148, 232]);
    expect(claim.human_edited).toBe(false);
  });
});

describe("writeCells / readCells", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createProject(dir, NEPAL_FIELDS);
  });
  afterEach(() => cleanTmp(dir));

  it("round-trips CellsJson", async () => {
    await writeCells(dir, NEPAL_CELLS);
    const result = await readCells(dir);

    const cell = result.table_13_livestock_by_type?.cattle_head;
    expect(cell).toBeDefined();
    expect(cell!.value).toBe(4612472);
    expect(cell!.unit).toBe("head");
    expect(cell!.derived).toBe(false);
    expect(cell!.sources[0].table_id).toBe(
      "01-main-report-t023-livestock-by-type",
    );
    expect(cell!.sources[0].row).toBe("Cattle");
    expect(cell!.sources[0].column).toBe("Head");
  });
});

// ---------------------------------------------------------------------------
// appendAuditEvent
// ---------------------------------------------------------------------------

describe("appendAuditEvent", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createProject(dir, NEPAL_FIELDS);
  });
  afterEach(() => cleanTmp(dir));

  it("appends a second event to the same file on the same day", async () => {
    const event: AuditEvent = {
      type: "source_added",
      timestamp: new Date().toISOString(),
      source_id: "test-source",
      filename: "test.pdf",
      sha256: "abc123",
    };
    await appendAuditEvent(dir, event);

    const files = await listAuditFiles(dir);
    expect(files).toHaveLength(1); // still one file — same date

    const auditDate = files[0].replace("-events.jsonl", "");
    const raw = await readFile(auditFilePath(dir, auditDate), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    // project_created + source_added
    expect(lines.length).toBeGreaterThanOrEqual(2);

    const last = JSON.parse(lines[lines.length - 1]) as AuditEvent;
    expect(last.type).toBe("source_added");
  });

  it("each appended line is valid JSON with a type field", async () => {
    const events: AuditEvent[] = [
      {
        type: "flag_raised",
        timestamp: new Date().toISOString(),
        location: "table_13.cattle_head",
        flag_label: "value-out-of-range",
      },
      {
        type: "flag_resolved",
        timestamp: new Date().toISOString(),
        location: "table_13.cattle_head",
        flag_label: "value-out-of-range",
        resolution: "verified against source p87",
      },
    ];

    for (const e of events) {
      await appendAuditEvent(dir, e);
    }

    const files = await listAuditFiles(dir);
    const auditDate = files[0].replace("-events.jsonl", "");
    const raw = await readFile(auditFilePath(dir, auditDate), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);

    for (const line of lines) {
      const parsed = JSON.parse(line) as AuditEvent;
      expect(parsed.type).toBeTruthy();
      expect(parsed.timestamp).toBeTruthy();
    }
  });

  it("generation_completed event carries all required fields", async () => {
    const event: AuditEvent = {
      type: "generation_completed",
      timestamp: new Date().toISOString(),
      target: "mr",
      section_or_table: "section_1",
      prompt_version: "v1.3",
      model: "deepseek-v4-flash",
      provider: "deepseek",
      input_tokens: 4200,
      output_tokens: 830,
      cost_usd: 0.000824,
      wall_time_ms: 3200,
    };
    await appendAuditEvent(dir, event);

    const files = await listAuditFiles(dir);
    const auditDate = files[0].replace("-events.jsonl", "");
    const raw = await readFile(auditFilePath(dir, auditDate), "utf-8");
    const lines = raw.trim().split("\n").filter(Boolean);
    const last = JSON.parse(lines[lines.length - 1]) as AuditEvent;

    expect(last.type).toBe("generation_completed");
    if (last.type === "generation_completed") {
      expect(last.input_tokens).toBe(4200);
      expect(last.cost_usd).toBeCloseTo(0.000824, 8);
      expect(last.provider).toBe("deepseek");
    }
  });
});

// ---------------------------------------------------------------------------
// validateProject — full Nepal fixture (happy path)
// ---------------------------------------------------------------------------

describe("validateProject — full Nepal fixture", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createNepalFixture(dir);
  });
  afterEach(() => cleanTmp(dir));

  it("returns no issues for a structurally complete project", async () => {
    const issues = await validateProject(dir);
    const errors = issues.filter((i) => i.severity === "error");
    expect(errors).toEqual([]);
  });

  it("returns no issues at all (zero warnings too) for the Nepal fixture", async () => {
    const issues = await validateProject(dir);
    expect(issues).toEqual([]);
  });
});

// ---------------------------------------------------------------------------
// validateProject — error cases
// ---------------------------------------------------------------------------

describe("validateProject — error cases", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createNepalFixture(dir);
  });
  afterEach(() => cleanTmp(dir));

  it("reports an error when manifest.json is missing", async () => {
    const { unlink } = await import("node:fs/promises");
    await unlink(manifestPath(dir));

    const issues = await validateProject(dir);
    const e = issues.find(
      (i) => i.severity === "error" && i.path === "manifest.json",
    );
    expect(e).toBeDefined();
    expect(e!.message).toMatch(/does not exist/i);
  });

  it("reports an error when manifest.json contains invalid JSON", async () => {
    await writeFile(manifestPath(dir), "{ broken json }", "utf-8");

    const issues = await validateProject(dir);
    const e = issues.find(
      (i) => i.severity === "error" && i.path === "manifest.json",
    );
    expect(e).toBeDefined();
    expect(e!.message).toMatch(/not valid JSON/i);
  });

  it("reports an error when a required manifest field is empty", async () => {
    const m = await readManifest(dir);
    (m as Manifest & { country: string }).country = "";
    await writeManifest(dir, m);

    const issues = await validateProject(dir);
    const e = issues.find(
      (i) => i.severity === "error" && i.path === "manifest.country",
    );
    expect(e).toBeDefined();
  });

  it("reports an error when sources/_index.json is missing", async () => {
    const { unlink } = await import("node:fs/promises");
    await unlink(sourceIndexPath(dir));

    const issues = await validateProject(dir);
    const e = issues.find(
      (i) =>
        i.severity === "error" && i.path === "sources/_index.json",
    );
    expect(e).toBeDefined();
    expect(e!.message).toMatch(/does not exist/i);
  });

  it("reports an error when sources/_index.json is not valid JSON", async () => {
    await writeFile(sourceIndexPath(dir), "not json", "utf-8");

    const issues = await validateProject(dir);
    const e = issues.find(
      (i) =>
        i.severity === "error" && i.path === "sources/_index.json",
    );
    expect(e).toBeDefined();
  });

  it("reports an error when evidence/_evidence.json is missing", async () => {
    const { unlink } = await import("node:fs/promises");
    await unlink(evidenceIndexPath(dir));

    const issues = await validateProject(dir);
    const e = issues.find(
      (i) =>
        i.severity === "error" &&
        i.path === "evidence/_evidence.json",
    );
    expect(e).toBeDefined();
  });

  it("reports an error when drafts/mr/_claims.json is missing", async () => {
    const { unlink } = await import("node:fs/promises");
    await unlink(claimsPath(dir));

    const issues = await validateProject(dir);
    const e = issues.find(
      (i) =>
        i.severity === "error" &&
        i.path === "drafts/mr/_claims.json",
    );
    expect(e).toBeDefined();
  });

  it("reports an error when drafts/tmr/_cells.json is missing", async () => {
    const { unlink } = await import("node:fs/promises");
    await unlink(cellsPath(dir));

    const issues = await validateProject(dir);
    const e = issues.find(
      (i) =>
        i.severity === "error" &&
        i.path === "drafts/tmr/_cells.json",
    );
    expect(e).toBeDefined();
  });

  it("reports an error for a corrupt JSONL audit line", async () => {
    const files = await listAuditFiles(dir);
    const auditDate = files[0].replace("-events.jsonl", "");
    const fpath = auditFilePath(dir, auditDate);
    // Append a corrupt line
    const { appendFile } = await import("node:fs/promises");
    await appendFile(fpath, "NOT VALID JSON\n", "utf-8");

    const issues = await validateProject(dir);
    const e = issues.find(
      (i) => i.severity === "error" && i.path.startsWith("audit/"),
    );
    expect(e).toBeDefined();
    expect(e!.message).toMatch(/not valid JSON/i);
  });
});

// ---------------------------------------------------------------------------
// validateProject — cross-reference warnings
// ---------------------------------------------------------------------------

describe("validateProject — cross-reference warnings", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createProject(dir, NEPAL_FIELDS);
  });
  afterEach(() => cleanTmp(dir));

  it("warns when a manifest source_document id is not in _index.json", async () => {
    // Write a manifest that lists a source not in the index
    const manifest = await readManifest(dir);
    manifest.source_documents.push({
      id: "99-ghost-report",
      title: "Ghost",
      url: "https://example.com",
      retrieved: "2026-01-01",
      language: "en",
    });
    await writeManifest(dir, manifest);

    const issues = await validateProject(dir);
    const w = issues.find(
      (i) =>
        i.severity === "warning" &&
        i.message.includes("99-ghost-report"),
    );
    expect(w).toBeDefined();
  });

  it("warns when a _index.json entry id is not in manifest.source_documents", async () => {
    // Add directly to _index.json without going through addSource
    const { readFile, writeFile } = await import("node:fs/promises");
    const raw = await readFile(sourceIndexPath(dir), "utf-8");
    const index = JSON.parse(raw) as SourceIndexEntry[];
    index.push({ ...NEPAL_SOURCE, id: "orphan-source" });
    await writeFile(
      sourceIndexPath(dir),
      JSON.stringify(index, null, 2),
      "utf-8",
    );

    const issues = await validateProject(dir);
    const w = issues.find(
      (i) =>
        i.severity === "warning" &&
        i.message.includes("orphan-source"),
    );
    expect(w).toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Audit file date-naming convention
// ---------------------------------------------------------------------------

describe("audit file naming", () => {
  let dir: string;
  beforeEach(async () => {
    dir = await makeTmp();
    await createProject(dir, NEPAL_FIELDS);
  });
  afterEach(() => cleanTmp(dir));

  it("names the audit file YYYY-MM-DD-events.jsonl with today's date", async () => {
    const today = new Date().toISOString().slice(0, 10);
    const files = await listAuditFiles(dir);
    expect(files).toHaveLength(1);
    expect(files[0]).toBe(`${today}-events.jsonl`);
  });
});
