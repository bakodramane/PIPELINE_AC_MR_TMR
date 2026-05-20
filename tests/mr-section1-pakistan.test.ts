/**
 * End-to-end test for MR section 1 generator against the Pakistan census.
 *
 * Confirms the generator works identically for Pakistan — no country-specific
 * code paths, same architecture as the Nepal test.
 *
 * Skip conditions (each announced with a console message):
 *   - DEEPSEEK_API_KEY not set (after loading .env)
 *   - Pakistan main report PDF not present at
 *     references/pakistan-2024/sources/main-report.pdf
 *
 * The test creates a temporary project directory, runs the ingest pipeline
 * to populate the evidence store, then calls generateSection(1) and asserts:
 *   - _claims.json has ≥ 3 claims under section_1
 *   - every claim has ≥ 1 source citation
 *   - every cited page_id exists on disk (zero unverified citations)
 *   - current.md exists and has > 100 characters
 *   - the audit log contains a generation_completed event
 *   - prints current.md content to the console for review
 */

import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtemp, rm, stat, readFile, access } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generateSection } from "../src/generators/mr";
import { ingestPdf } from "../src/ingest/pipeline";
import {
  createProject,
  readClaims,
  listAuditFiles,
} from "../src/project/io";

// ---------------------------------------------------------------------------
// Path resolution helpers — identical pattern to tests/mr-section1.test.ts
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const PDF_RELATIVE = path.join(
  "references",
  "pakistan-2024",
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
    "\n[mr-section1-pakistan.test.ts] SKIP — DEEPSEEK_API_KEY is not set.\n" +
      "Set it in your .env file or as an environment variable to run this test.\n",
  );
}

const projectRoot = await findDirContaining(PDF_RELATIVE);
const PAKISTAN_PDF = path.join(projectRoot, PDF_RELATIVE);

let pdfPresent = false;
try {
  await stat(PAKISTAN_PDF);
  pdfPresent = true;
} catch {
  console.warn(
    "\n[mr-section1-pakistan.test.ts] SKIP — Pakistan census PDF not found at:\n" +
      `  ${PAKISTAN_PDF}\n` +
      "Place the Pakistan 2024 main report PDF at that path to run this test.\n",
  );
}

const shouldRun = apiKeyPresent && pdfPresent;

// ---------------------------------------------------------------------------
// Minimal project manifest fields for Pakistan
// ---------------------------------------------------------------------------

const FIELDS = {
  country: "Pakistan",
  country_iso3: "PAK",
  census_round: "WCA 2020",
  census_name: "Agricultural Census of Pakistan 2024",
  reference_year: "2024",
  reference_day: "day of interview",
  methodology_type: "complete enumeration",
  statistical_unit: "agricultural holding",
  lower_size_threshold: "information not available",
  national_statistical_office:
    "Pakistan Bureau of Statistics (PBS)",
  compiled_by: "test@fao.org",
};

const SOURCE_DOC_ID = "01-main-report";

// ---------------------------------------------------------------------------
// Suite
// ---------------------------------------------------------------------------

describe("MR section 1 generator (Pakistan)", () => {
  let projectDir = "";

  // Run ingest + generation in beforeAll so individual tests are pure assertions.
  // Long timeout: PDF ingest (~15 s) + API call (~30 s) = allow 3 min.
  beforeAll(async () => {
    if (!shouldRun) return;

    projectDir = await mkdtemp(
      path.join(os.tmpdir(), "agcensus-pak-mr-test-"),
    );
    await createProject(projectDir, FIELDS);

    // Populate the evidence store from the real Pakistan PDF
    await ingestPdf(projectDir, SOURCE_DOC_ID, PAKISTAN_PDF, "en");

    // Generate Section 1 — same call as Nepal, no country-specific branches
    await generateSection(projectDir, 1, "deepseek-v4-flash");
  }, 180_000);

  afterAll(async () => {
    if (projectDir) {
      await rm(projectDir, { recursive: true, force: true });
    }
  });

  // ── Assertions (identical contract to the Nepal test) ─────────────────────

  it("_claims.json contains at least 3 claims under section_1", async (ctx) => {
    if (!shouldRun) ctx.skip();
    const claims = await readClaims(projectDir);
    expect(claims.section_1).toBeDefined();
    expect(claims.section_1.claims.length).toBeGreaterThanOrEqual(3);
  });

  it("every claim has at least one source citation", async (ctx) => {
    if (!shouldRun) ctx.skip();
    const claims = await readClaims(projectDir);
    for (const claim of claims.section_1?.claims ?? []) {
      expect(
        claim.sources.length,
        `claim ${claim.claim_id} has no source citations`,
      ).toBeGreaterThan(0);
    }
  });

  it("every cited page_id exists on disk — zero unverified citations", async (ctx) => {
    if (!shouldRun) ctx.skip();
    const claims = await readClaims(projectDir);
    const pagesDir = path.join(projectDir, "evidence", "pages");
    for (const claim of claims.section_1?.claims ?? []) {
      for (const source of claim.sources) {
        const pageFile = path.join(pagesDir, `${source.page_id}.json`);
        await expect(
          access(pageFile),
          `cited page_id "${source.page_id}" (claim ${claim.claim_id}) does not exist on disk`,
        ).resolves.toBeUndefined();
      }
    }
  });

  it("current.md exists and contains more than 100 characters", async (ctx) => {
    if (!shouldRun) ctx.skip();
    const mdPath = path.join(projectDir, "drafts", "mr", "current.md");
    const content = await readFile(mdPath, "utf-8");
    expect(content.length).toBeGreaterThan(100);

    // Print the generated section so the reviewer can read it
    console.log("\n" + "=".repeat(60));
    console.log("GENERATED drafts/mr/current.md  [Pakistan]");
    console.log("=".repeat(60));
    console.log(content);
    console.log("=".repeat(60) + "\n");
  });

  it("audit log contains a generation_completed event", async (ctx) => {
    if (!shouldRun) ctx.skip();
    const auditFiles = await listAuditFiles(projectDir);
    let found = false;
    for (const filename of auditFiles) {
      const filePath = path.join(projectDir, "audit", filename);
      const content = await readFile(filePath, "utf-8");
      if (content.includes('"generation_completed"')) {
        found = true;
        break;
      }
    }
    expect(found, "no generation_completed event in audit log").toBe(true);
  });
});
