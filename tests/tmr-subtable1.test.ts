/**
 * End-to-end test for TMR sub-table 1 generator against the Nepal census.
 *
 * Sub-table 1: Holdings and area, by legal status.
 * Gold standard values for Nepal NSCA 2021/2022:
 *   Total_Holdings : 4,130,789 holdings
 *   Total_Area     : 2,218,410 ha
 *
 * Skip conditions (each announced with a console message):
 *   - DEEPSEEK_API_KEY not set (after loading .env)
 *   - Nepal census PDF not present at
 *     references/nepal-2021/sources/main-report.pdf
 *
 * The test creates a temporary project directory, runs the ingest pipeline,
 * then calls generateSubTable(1) and asserts:
 *   - _cells.json contains sub_table_1
 *   - Total_Holdings matches the Nepal gold standard (4,130,789)
 *   - Total_Area matches the Nepal gold standard (2,218,410 ha, within ±1)
 *   - zero cells have unverified_source: true
 *   - validation_flags key exists (validation ran — empty = passed)
 *   - prints all populated cells to the console for review
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat, readFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateSubTable } from "../src/generators/tmr";
import { ingestPdf } from "../src/ingest/pipeline";
import {
  createProject,
  readCells,
  listAuditFiles,
} from "../src/project/io";

// ---------------------------------------------------------------------------
// Path resolution helpers — identical pattern to tests/mr-section1.test.ts
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PDF_RELATIVE = path.join(
  "references",
  "nepal-2021",
  "sources",
  "main-report.pdf",
);

const ENV_RELATIVE = ".env";

/**
 * Find the directory that contains `needle` by checking two explicit
 * candidates:
 *   1. Direct parent of tests/  (non-worktree layout)
 *   2. Four levels up from tests/  (worktree layout: tests/ → worktree →
 *      worktrees/ → .claude/ → project root)
 *
 * Returns the matching directory, or the direct parent if nothing is found.
 */
async function findDirContaining(needle: string): Promise<string> {
  const candidates = [
    path.resolve(__dirname, ".."),
    path.resolve(__dirname, "..", "..", "..", ".."),
  ];
  for (const candidate of candidates) {
    try {
      await stat(path.join(candidate, needle));
      return candidate;
    } catch {
      // not here — try next
    }
  }
  return path.resolve(__dirname, "..");
}

/**
 * Load .env from the first directory that contains one.
 * Does not overwrite variables already set in the shell.
 */
async function loadEnvFile(): Promise<void> {
  const dir = await findDirContaining(ENV_RELATIVE);
  const envPath = path.join(dir, ENV_RELATIVE);
  try {
    const content = await readFile(envPath, "utf-8");
    for (const line of content.split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const value = trimmed.slice(eqIdx + 1).trim();
      if (key && !(key in process.env)) {
        process.env[key] = value;
      }
    }
  } catch {
    // no .env found — env vars must be set externally
  }
}

// Load .env before checking API key presence
await loadEnvFile();

// ---------------------------------------------------------------------------
// Availability checks
// ---------------------------------------------------------------------------

const apiKey = process.env.DEEPSEEK_API_KEY;
const apiKeyPresent = Boolean(apiKey && apiKey.trim().length > 0);

if (!apiKeyPresent) {
  console.warn(
    "\n[tmr-subtable1.test.ts] SKIP — DEEPSEEK_API_KEY is not set.\n" +
      "Set it in your .env file or as an environment variable to run this test.\n",
  );
}

const projectRoot = await findDirContaining(PDF_RELATIVE);
const NEPAL_PDF = path.join(projectRoot, PDF_RELATIVE);

let pdfPresent = false;
try {
  await stat(NEPAL_PDF);
  pdfPresent = true;
} catch {
  console.warn(
    "\n[tmr-subtable1.test.ts] SKIP — Nepal census PDF not found at:\n" +
      `  ${NEPAL_PDF}\n` +
      "Place the Nepal 2021/2022 main report PDF at that path to run this test.\n",
  );
}

const shouldRun = apiKeyPresent && pdfPresent;

// ---------------------------------------------------------------------------
// Minimal project manifest fields
// ---------------------------------------------------------------------------

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

const SOURCE_DOC_ID = "01-main-report";

// Nepal TMR gold standard for sub-table 1
const GOLD_TOTAL_HOLDINGS = 4_130_789;
const GOLD_TOTAL_AREA_HA = 2_218_410;

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("TMR sub-table 1 generator (Nepal)", () => {
  let projectDir = "";

  // Run ingest + generation in beforeAll so individual tests are pure assertions.
  // Long timeout: PDF ingest (~15 s) + API call (~30 s) = allow 3 min.
  beforeAll(async () => {
    if (!shouldRun) return;

    projectDir = await mkdtemp(
      path.join(os.tmpdir(), "agcensus-tmr-test-"),
    );
    await createProject(projectDir, FIELDS);

    // Populate the evidence store from the real Nepal PDF
    await ingestPdf(projectDir, SOURCE_DOC_ID, NEPAL_PDF, "en");

    // Generate sub-table 1
    await generateSubTable(projectDir, 1, "deepseek-v4-flash");
  }, 180_000);

  afterAll(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  // ── Assertions ─────────────────────────────────────────────────────────────

  it("_cells.json contains sub_table_1", async (ctx) => {
    if (!shouldRun) ctx.skip();
    const cells = await readCells(projectDir);
    expect(cells.sub_table_1).toBeDefined();
  });

  it(`Total_Holdings matches Nepal gold standard (${GOLD_TOTAL_HOLDINGS.toLocaleString()})`, async (ctx) => {
    if (!shouldRun) ctx.skip();
    const cells = await readCells(projectDir);
    const subTable = cells.sub_table_1 as Record<string, unknown>;
    const cell = subTable["Total_Holdings"] as { value: unknown } | undefined;
    expect(cell, "Total_Holdings cell is missing").toBeDefined();
    expect(
      cell!.value,
      `Total_Holdings value ${cell!.value} ≠ gold standard ${GOLD_TOTAL_HOLDINGS}`,
    ).toBe(GOLD_TOTAL_HOLDINGS);
  });

  it(`Total_Area matches Nepal gold standard (${GOLD_TOTAL_AREA_HA.toLocaleString()} ha, within ±1)`, async (ctx) => {
    if (!shouldRun) ctx.skip();
    const cells = await readCells(projectDir);
    const subTable = cells.sub_table_1 as Record<string, unknown>;
    const cell = subTable["Total_Area"] as { value: unknown } | undefined;
    expect(cell, "Total_Area cell is missing").toBeDefined();
    expect(
      typeof cell!.value === "number",
      `Total_Area value "${cell!.value}" is not a number`,
    ).toBe(true);
    const delta = Math.abs((cell!.value as number) - GOLD_TOTAL_AREA_HA);
    expect(
      delta,
      `Total_Area value ${cell!.value} differs from gold standard ${GOLD_TOTAL_AREA_HA} by ${delta} (> 1)`,
    ).toBeLessThanOrEqual(1);
  });

  it("zero cells have unverified_source: true", async (ctx) => {
    if (!shouldRun) ctx.skip();
    const cells = await readCells(projectDir);
    const subTable = cells.sub_table_1 as Record<string, unknown>;
    for (const [key, value] of Object.entries(subTable)) {
      // Skip metadata keys
      if (key === "validation_flags" || key === "parse_failed" || key === "raw_response") {
        continue;
      }
      const cell = value as { unverified_source?: boolean };
      expect(
        cell.unverified_source,
        `cell "${key}" has unverified_source: true — source table not found on disk`,
      ).not.toBe(true);
    }
  });

  it("validation_flags exists — validation rule ran (empty = passed)", async (ctx) => {
    if (!shouldRun) ctx.skip();
    const cells = await readCells(projectDir);
    const subTable = cells.sub_table_1 as Record<string, unknown>;
    expect(
      subTable["validation_flags"],
      "validation_flags key missing — validation did not run",
    ).toBeDefined();
    expect(
      Array.isArray(subTable["validation_flags"]),
      "validation_flags must be an array",
    ).toBe(true);
  });

  it("prints all populated cells for reviewer", async (ctx) => {
    if (!shouldRun) ctx.skip();
    const cells = await readCells(projectDir);
    console.log("\n" + "=".repeat(60));
    console.log("POPULATED _cells.json / sub_table_1  [Nepal]");
    console.log("=".repeat(60));
    console.log(JSON.stringify(cells.sub_table_1, null, 2));
    console.log("=".repeat(60) + "\n");
  });

  it("audit log contains a generation_completed event for tmr", async (ctx) => {
    if (!shouldRun) ctx.skip();
    const auditFiles = await listAuditFiles(projectDir);
    let found = false;
    for (const filename of auditFiles) {
      const filePath = path.join(projectDir, "audit", filename);
      const content = await readFile(filePath, "utf-8");
      if (
        content.includes('"generation_completed"') &&
        content.includes('"tmr"')
      ) {
        found = true;
        break;
      }
    }
    expect(found, "no TMR generation_completed event in audit log").toBe(true);
  });
});
