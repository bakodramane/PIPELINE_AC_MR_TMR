/**
 * scripts/verify-pakistan-tmr.ts — Session 11 verification script.
 *
 * Ingests references/pakistan-2024/sources/02-statistical-tables.pdf into a
 * fresh temp project, runs TMR sub-tables 1 and 2 with deepseek-v4-flash, then
 * reports whether Total_Holdings is populated and matches the gold standard.
 *
 * Target (gold standard from Pakistan TMR):
 *   Total_Holdings = 11,701,584
 *
 * Run with:
 *   node "C:\Users\Dramane\Desktop\PIPELINE\node_modules\vitest\vitest.mjs" ^
 *     run --root "C:\Users\Dramane\Desktop\PIPELINE" ^
 *     --config vitest.scripts.config.ts ^
 *     --reporter verbose ^
 *     --testNamePattern "Pakistan TMR"
 *
 * Requires DEEPSEEK_API_KEY in .env or environment.
 */

import { test, beforeAll, expect } from "vitest";
import { mkdtemp, readFile, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { createProject } from "../src/project/io";
import { ingestPdf } from "../src/ingest/pipeline";
import { generateSubTable } from "../src/generators/tmr";

// ---------------------------------------------------------------------------
// Path resolution (handles both normal and worktree layouts)
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

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

async function loadEnvFile(): Promise<void> {
  const dir = await findDirContaining(".env");
  const envPath = path.join(dir, ".env");
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
    // no .env — env vars must be set externally
  }
}

await loadEnvFile();

// ---------------------------------------------------------------------------
// Pre-flight
// ---------------------------------------------------------------------------

const TARGET_TOTAL_HOLDINGS = 11_701_584;

const apiKey = process.env["DEEPSEEK_API_KEY"];
const apiKeyPresent = Boolean(apiKey && apiKey.trim().length > 0);

if (!apiKeyPresent) {
  console.warn(
    "\n[verify-pakistan-tmr] SKIP — DEEPSEEK_API_KEY is not set.\n",
  );
}

const projectRoot = await findDirContaining("references");
const PDF_PATH = path.join(
  projectRoot,
  "references",
  "pakistan-2024",
  "sources",
  "02-statistical-tables.pdf",
);

let pdfPresent = false;
try {
  await stat(PDF_PATH);
  pdfPresent = true;
} catch {
  console.warn(
    "\n[verify-pakistan-tmr] SKIP — Pakistan statistical tables PDF not found at:\n" +
      `  ${PDF_PATH}\n`,
  );
}

const shouldRun = apiKeyPresent && pdfPresent;

// ---------------------------------------------------------------------------
// Shared state populated in beforeAll
// ---------------------------------------------------------------------------

let projectDir = "";
let st1Cells: Record<string, unknown> = {};
let st2Cells: Record<string, unknown> = {};

// ---------------------------------------------------------------------------
// beforeAll: ingest + generate (shared across both tests)
// ---------------------------------------------------------------------------

beforeAll(
  async () => {
    if (!shouldRun) return;

    // ── 1. Create fresh project ───────────────────────────────────────────
    projectDir = await mkdtemp(
      path.join(os.tmpdir(), "agcensus-pak-tmr-verify-"),
    );
    console.log(`\n[verify-pak-tmr] Project dir: ${projectDir}`);

    await createProject(projectDir, {
      country: "Pakistan",
      country_iso3: "PAK",
      census_round: "WCA 2020",
      census_name: "Agricultural Census Pakistan 2024",
      reference_year: "2024",
      reference_day: "day of interview",
      methodology_type: "complete enumeration",
      statistical_unit: "agricultural holding",
      lower_size_threshold:
        "holdings reporting any area operated or any livestock",
      national_statistical_office: "Pakistan Bureau of Statistics (PBS)",
      compiled_by: "bakodramane@gmail.com",
    });

    // ── 2. Ingest 02-statistical-tables.pdf ──────────────────────────────
    console.log(`[verify-pak-tmr] Ingesting: ${PDF_PATH}`);
    const ingestStart = Date.now();
    await ingestPdf(projectDir, "02-statistical-tables", PDF_PATH, "en");
    const ingestMs = Date.now() - ingestStart;

    const evidenceRaw = await readFile(
      path.join(projectDir, "evidence", "_evidence.json"),
      "utf-8",
    );
    const evidenceIndex = JSON.parse(evidenceRaw) as {
      pages: unknown[];
      tables: unknown[];
    };
    console.log(
      `[verify-pak-tmr] Indexed ${evidenceIndex.pages.length} pages, ` +
        `${evidenceIndex.tables.length} tables in ${ingestMs} ms`,
    );

    // ── 3. Generate ST1 and ST2 ───────────────────────────────────────────
    console.log("[verify-pak-tmr] Generating sub-table 1 ...");
    await generateSubTable(projectDir, 1, "deepseek-v4-flash");

    console.log("[verify-pak-tmr] Generating sub-table 2 ...");
    await generateSubTable(projectDir, 2, "deepseek-v4-flash");

    // ── 4. Read _cells.json ───────────────────────────────────────────────
    const cellsRaw = await readFile(
      path.join(projectDir, "drafts", "tmr", "_cells.json"),
      "utf-8",
    );
    const cellsJson = JSON.parse(cellsRaw) as Record<
      string,
      Record<string, unknown>
    >;
    st1Cells = cellsJson["sub_table_1"] ?? {};
    st2Cells = cellsJson["sub_table_2"] ?? {};

    // ── 5. Print populated cells ──────────────────────────────────────────
    const line = "=".repeat(64);
    console.log(`\n${line}`);
    console.log("PAKISTAN TMR VERIFY — Sub-table 1 (Holdings by legal status)");
    console.log(line);
    for (const [key, cell] of Object.entries(st1Cells)) {
      if (key === "validation_flags" || key === "parse_failed" || key === "truncated") continue;
      const c = cell as { value: unknown; unit: string; unverified_source?: boolean };
      const verified = c.unverified_source ? " [UNVERIFIED]" : "";
      console.log(`  ${key}: ${c.value} ${c.unit}${verified}`);
    }

    console.log(`\n${line}`);
    console.log("PAKISTAN TMR VERIFY — Sub-table 2 (Holdings by tenure)");
    console.log(line);
    for (const [key, cell] of Object.entries(st2Cells)) {
      if (key === "validation_flags" || key === "parse_failed" || key === "truncated") continue;
      const c = cell as { value: unknown; unit: string; unverified_source?: boolean };
      const verified = c.unverified_source ? " [UNVERIFIED]" : "";
      console.log(`  ${key}: ${c.value} ${c.unit}${verified}`);
    }
    console.log(line);

    // Report parse_failed / truncation status
    if (st1Cells["parse_failed"]) {
      console.warn(
        `[verify-pak-tmr] ⚠ ST1 parse_failed=${st1Cells["parse_failed"]}` +
          (st1Cells["truncated"] ? ` truncated=true` : ""),
      );
    }
    if (st2Cells["parse_failed"]) {
      console.warn(
        `[verify-pak-tmr] ⚠ ST2 parse_failed=${st2Cells["parse_failed"]}` +
          (st2Cells["truncated"] ? ` truncated=true` : ""),
      );
    }
  },
  30 * 60 * 1000, // 30-minute beforeAll timeout
);

// ---------------------------------------------------------------------------
// Tests
// ---------------------------------------------------------------------------

test(
  "Pakistan TMR ST1: Total_Holdings cell is populated with a number",
  { timeout: 30 * 60 * 1000 },
  (ctx) => {
    if (!shouldRun) {
      ctx.skip();
      return;
    }
    const totalHoldings = (
      st1Cells["Total_Holdings"] as { value: unknown } | undefined
    )?.value;
    console.log(
      `\n  Total_Holdings = ${totalHoldings} (target: ${TARGET_TOTAL_HOLDINGS.toLocaleString()})`,
    );
    expect(
      typeof totalHoldings,
      "Total_Holdings should be a number — statistical tables PDF must contain this value",
    ).toBe("number");
  },
);

test(
  "Pakistan TMR ST1: Total_Holdings matches gold-standard target (±1000)",
  { timeout: 30 * 60 * 1000 },
  (ctx) => {
    if (!shouldRun) {
      ctx.skip();
      return;
    }
    const totalHoldings = (
      st1Cells["Total_Holdings"] as { value: number } | undefined
    )?.value;
    if (typeof totalHoldings !== "number") {
      ctx.skip(); // already failing in the previous test
      return;
    }
    const delta = Math.abs(totalHoldings - TARGET_TOTAL_HOLDINGS);
    console.log(
      `  Delta from target: ${delta.toLocaleString()} (tolerance: 1,000)`,
    );
    expect(
      delta,
      `Total_Holdings ${totalHoldings.toLocaleString()} should be within 1,000 of ` +
        TARGET_TOTAL_HOLDINGS.toLocaleString(),
    ).toBeLessThanOrEqual(1000);
  },
);
