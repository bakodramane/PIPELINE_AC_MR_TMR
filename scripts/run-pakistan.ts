/**
 * scripts/run-pakistan.ts — Session 10 end-to-end pipeline run for Pakistan.
 *
 * Creates a fresh Pakistan project in a temp directory, ingests the Pakistan 2024
 * main census report, generates all 15 MR sections and 23 TMR sub-tables using
 * deepseek-v4-flash, then writes a summary to docs/pakistan-run-summary.json.
 *
 * Run with:
 *   node "C:\Users\Dramane\Desktop\PIPELINE\node_modules\vitest\vitest.mjs" ^
 *     run --root "C:\Users\Dramane\Desktop\PIPELINE" ^
 *     scripts/run-pakistan.ts --reporter verbose
 *
 * Requires DEEPSEEK_API_KEY in .env or environment.
 * Estimated runtime: 30–90 minutes.
 * Estimated cost: USD 1–3 on DeepSeek V4-Flash.
 */

import { test } from "vitest";
import { mkdtemp, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { fileURLToPath } from "node:url";

import { createProject, listAuditFiles } from "../src/project/io";
import { ingestPdf } from "../src/ingest/pipeline";
import { generateSection } from "../src/generators/mr";
import { generateSubTable } from "../src/generators/tmr";

// ---------------------------------------------------------------------------
// Path resolution — handles both direct and worktree layouts
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
      // not here — try the next candidate
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
    // no .env found — env vars must be set externally
  }
}

await loadEnvFile();

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

const apiKey = process.env["DEEPSEEK_API_KEY"];
const apiKeyPresent = Boolean(apiKey && apiKey.trim().length > 0);

if (!apiKeyPresent) {
  console.warn(
    "\n[run-pakistan] SKIP — DEEPSEEK_API_KEY is not set.\n" +
      "Set it in .env or as an environment variable and re-run.\n",
  );
}

const projectRoot = await findDirContaining("references");
const PDF_PATH = path.join(
  projectRoot,
  "references",
  "pakistan-2024",
  "sources",
  "main-report.pdf",
);

let pdfPresent = false;
try {
  await stat(PDF_PATH);
  pdfPresent = true;
} catch {
  console.warn(
    "\n[run-pakistan] SKIP — Pakistan census PDF not found at:\n" +
      `  ${PDF_PATH}\n`,
  );
}

const shouldRun = apiKeyPresent && pdfPresent;

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface MrSectionResult {
  status: "ok" | "parse_failed" | "empty";
  claims_count: number;
  wall_time_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

interface TmrSubTableResult {
  status: "ok" | "parse_failed" | "empty";
  cells_populated: number;
  cells_missing: number;
  validation_flags_count: number;
  wall_time_ms: number;
  input_tokens: number;
  output_tokens: number;
  cost_usd: number;
}

// ---------------------------------------------------------------------------
// Project manifest fields
// ---------------------------------------------------------------------------

const MODEL = "deepseek-v4-flash" as const;
const SOURCE_DOC_ID = "01-main-report";

const FIELDS = {
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
};

// ---------------------------------------------------------------------------
// Main E2E run test
// ---------------------------------------------------------------------------

test(
  "Pakistan end-to-end pipeline run",
  async (ctx) => {
    if (!shouldRun) {
      ctx.skip();
      return;
    }

    // ── 1. Create project ──────────────────────────────────────────────────
    const projectDir = await mkdtemp(
      path.join(os.tmpdir(), "agcensus-pakistan-"),
    );
    console.log(`\n[Pakistan] Project dir: ${projectDir}`);
    await createProject(projectDir, FIELDS);

    // ── 2. Ingest PDF ──────────────────────────────────────────────────────
    console.log(`[Pakistan] Ingesting: ${PDF_PATH}`);
    const ingestStart = Date.now();
    await ingestPdf(projectDir, SOURCE_DOC_ID, PDF_PATH, "en");
    const ingestTimeMs = Date.now() - ingestStart;

    const evidenceRaw = await readFile(
      path.join(projectDir, "evidence", "_evidence.json"),
      "utf-8",
    );
    const evidenceIndex = JSON.parse(evidenceRaw) as {
      pages: unknown[];
      tables: unknown[];
    };
    const pagesIndexed = evidenceIndex.pages.length;
    const tablesIndexed = evidenceIndex.tables.length;
    console.log(
      `[Pakistan] Indexed ${pagesIndexed} pages, ${tablesIndexed} tables in ${ingestTimeMs} ms`,
    );

    // ── 3. Generate MR sections 1–15 (sequential) ─────────────────────────
    const mrResults: Record<string, MrSectionResult> = {};

    for (let s = 1; s <= 15; s++) {
      console.log(`[Pakistan] MR section ${s}/15 ...`);
      const wallStart = Date.now();
      await generateSection(projectDir, s, MODEL);
      mrResults[`section_${s}`] = {
        status: "ok",
        claims_count: 0,
        wall_time_ms: Date.now() - wallStart,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      };
    }

    // ── 4. Generate TMR sub-tables 1–23 (sequential) ──────────────────────
    const tmrResults: Record<string, TmrSubTableResult> = {};

    for (let t = 1; t <= 23; t++) {
      console.log(`[Pakistan] TMR sub-table ${t}/23 ...`);
      const wallStart = Date.now();
      await generateSubTable(projectDir, t, MODEL);
      tmrResults[`sub_table_${t}`] = {
        status: "ok",
        cells_populated: 0,
        cells_missing: 0,
        validation_flags_count: 0,
        wall_time_ms: Date.now() - wallStart,
        input_tokens: 0,
        output_tokens: 0,
        cost_usd: 0,
      };
    }

    // ── 5. Enrich MR results from _claims.json ────────────────────────────
    const claimsRaw = await readFile(
      path.join(projectDir, "drafts", "mr", "_claims.json"),
      "utf-8",
    );
    const allClaims = JSON.parse(claimsRaw) as Record<
      string,
      { claims: unknown[] } | undefined
    >;

    for (let s = 1; s <= 15; s++) {
      const key = `section_${s}`;
      const section = allClaims[key];
      const count = section?.claims?.length ?? 0;
      mrResults[key]!.claims_count = count;
      mrResults[key]!.status = !section
        ? "parse_failed"
        : count > 0
          ? "ok"
          : "empty";
    }

    // ── 6. Enrich TMR results from _cells.json ────────────────────────────
    const cellsRaw = await readFile(
      path.join(projectDir, "drafts", "tmr", "_cells.json"),
      "utf-8",
    );
    const allCells = JSON.parse(cellsRaw) as Record<
      string,
      Record<string, unknown> | undefined
    >;

    for (let t = 1; t <= 23; t++) {
      const key = `sub_table_${t}`;
      const subTable = allCells[key];

      if (!subTable) {
        tmrResults[key]!.status = "empty";
        continue;
      }
      if (subTable["parse_failed"]) {
        tmrResults[key]!.status = "parse_failed";
        continue;
      }

      const cellEntries = Object.entries(subTable).filter(
        ([k]) => k !== "validation_flags" && k !== "parse_failed",
      );
      const populated = cellEntries.filter(
        ([, v]) => typeof (v as { value: unknown }).value === "number",
      ).length;
      const missing = cellEntries.filter(
        ([, v]) => (v as { value: unknown }).value === "..",
      ).length;
      const vFlags =
        (subTable["validation_flags"] as unknown[] | undefined) ?? [];

      tmrResults[key]!.cells_populated = populated;
      tmrResults[key]!.cells_missing = missing;
      tmrResults[key]!.validation_flags_count = vFlags.length;
      tmrResults[key]!.status = populated > 0 ? "ok" : "empty";
    }

    // ── 7. Enrich with token counts and costs from audit log ──────────────
    const auditFiles = await listAuditFiles(projectDir);
    let totalCostUsd = 0;
    let totalInputTokens = 0;
    let totalOutputTokens = 0;

    for (const filename of auditFiles) {
      const auditRaw = await readFile(
        path.join(projectDir, "audit", filename),
        "utf-8",
      );
      for (const line of auditRaw.split("\n").filter(Boolean)) {
        try {
          const event = JSON.parse(line) as {
            type: string;
            section_or_table?: string;
            input_tokens?: number;
            output_tokens?: number;
            cost_usd?: number;
          };
          if (event.type !== "generation_completed") continue;

          const sot = event.section_or_table ?? "";
          const inp = event.input_tokens ?? 0;
          const out = event.output_tokens ?? 0;
          const cost = event.cost_usd ?? 0;

          totalInputTokens += inp;
          totalOutputTokens += out;
          totalCostUsd += cost;

          if (sot.startsWith("section_") && mrResults[sot]) {
            mrResults[sot]!.input_tokens += inp;
            mrResults[sot]!.output_tokens += out;
            mrResults[sot]!.cost_usd += cost;
          } else if (sot.startsWith("sub_table_") && tmrResults[sot]) {
            tmrResults[sot]!.input_tokens += inp;
            tmrResults[sot]!.output_tokens += out;
            tmrResults[sot]!.cost_usd += cost;
          }
        } catch {
          // ignore malformed JSONL lines
        }
      }
    }

    // ── 8. Build summary object ───────────────────────────────────────────
    const totalMrClaims = Object.values(mrResults).reduce(
      (s, r) => s + r.claims_count,
      0,
    );
    const totalCellsPopulated = Object.values(tmrResults).reduce(
      (s, r) => s + r.cells_populated,
      0,
    );
    const totalCellsMissing = Object.values(tmrResults).reduce(
      (s, r) => s + r.cells_missing,
      0,
    );
    const totalWallTimeMs =
      Object.values(mrResults).reduce((s, r) => s + r.wall_time_ms, 0) +
      Object.values(tmrResults).reduce((s, r) => s + r.wall_time_ms, 0);

    const mrStatusCounts = {
      ok: Object.values(mrResults).filter((r) => r.status === "ok").length,
      empty: Object.values(mrResults).filter((r) => r.status === "empty")
        .length,
      parse_failed: Object.values(mrResults).filter(
        (r) => r.status === "parse_failed",
      ).length,
    };
    const tmrStatusCounts = {
      ok: Object.values(tmrResults).filter((r) => r.status === "ok").length,
      empty: Object.values(tmrResults).filter((r) => r.status === "empty")
        .length,
      parse_failed: Object.values(tmrResults).filter(
        (r) => r.status === "parse_failed",
      ).length,
    };

    const summary = {
      country: "Pakistan",
      country_iso3: "PAK",
      census_round: "WCA 2020",
      reference_year: "2024",
      session: "Session 10",
      run_timestamp: new Date().toISOString(),
      project_dir: projectDir,
      model: MODEL,
      pdf_ingested: {
        source_doc_id: SOURCE_DOC_ID,
        pdf_path: PDF_PATH,
        pages_indexed: pagesIndexed,
        tables_indexed: tablesIndexed,
        ingest_time_ms: ingestTimeMs,
      },
      mr_sections: mrResults,
      mr_status_counts: mrStatusCounts,
      tmr_sub_tables: tmrResults,
      tmr_status_counts: tmrStatusCounts,
      totals: {
        mr_claims_total: totalMrClaims,
        tmr_cells_populated: totalCellsPopulated,
        tmr_cells_missing: totalCellsMissing,
        total_input_tokens: totalInputTokens,
        total_output_tokens: totalOutputTokens,
        total_cost_usd: Math.round(totalCostUsd * 100000) / 100000,
        total_wall_time_ms: totalWallTimeMs,
        total_wall_time_minutes:
          Math.round((totalWallTimeMs / 60000) * 10) / 10,
      },
    };

    // ── 9. Write summary to docs/ ─────────────────────────────────────────
    const docsDir = path.join(projectRoot, "docs");
    const summaryPath = path.join(docsDir, "pakistan-run-summary.json");
    await mkdir(docsDir, { recursive: true });
    await writeFile(
      summaryPath,
      JSON.stringify(summary, null, 2) + "\n",
      "utf-8",
    );

    // ── 10. Console summary ───────────────────────────────────────────────
    const line = "=".repeat(64);
    console.log(`\n${line}`);
    console.log("PAKISTAN E2E RUN COMPLETE");
    console.log(line);
    console.log(`Project dir  : ${projectDir}`);
    console.log(
      `PDF          : ${pagesIndexed} pages, ${tablesIndexed} tables indexed`,
    );
    console.log(`Ingest time  : ${(ingestTimeMs / 1000).toFixed(1)} s`);

    console.log(`\nMR Sections (15):`);
    for (const [key, r] of Object.entries(mrResults)) {
      const icon =
        r.status === "ok" ? "✓" : r.status === "parse_failed" ? "✗" : "○";
      console.log(
        `  ${icon} ${key.padEnd(12)}: ${String(r.claims_count).padStart(2)} claims` +
          ` | ${String(r.wall_time_ms).padStart(7)} ms | $${r.cost_usd.toFixed(4)}`,
      );
    }
    console.log(
      `  → ok:${mrStatusCounts.ok}  empty:${mrStatusCounts.empty}  parse_failed:${mrStatusCounts.parse_failed}`,
    );

    console.log(`\nTMR Sub-tables (23):`);
    for (const [key, r] of Object.entries(tmrResults)) {
      const icon =
        r.status === "ok" ? "✓" : r.status === "parse_failed" ? "✗" : "○";
      console.log(
        `  ${icon} ${key.padEnd(14)}: ${String(r.cells_populated).padStart(3)} pop` +
          ` / ${String(r.cells_missing).padStart(3)} miss` +
          ` | vf:${r.validation_flags_count}` +
          ` | ${String(r.wall_time_ms).padStart(8)} ms | $${r.cost_usd.toFixed(4)}`,
      );
    }
    console.log(
      `  → ok:${tmrStatusCounts.ok}  empty:${tmrStatusCounts.empty}  parse_failed:${tmrStatusCounts.parse_failed}`,
    );

    console.log(`\nTOTALS:`);
    console.log(`  MR claims          : ${totalMrClaims}`);
    console.log(
      `  TMR cells          : ${totalCellsPopulated} populated / ${totalCellsMissing} missing`,
    );
    console.log(
      `  Tokens             : ${totalInputTokens.toLocaleString()} in / ${totalOutputTokens.toLocaleString()} out`,
    );
    console.log(`  Cost               : $${totalCostUsd.toFixed(4)}`);
    console.log(
      `  Wall time          : ${(totalWallTimeMs / 60000).toFixed(1)} minutes`,
    );
    console.log(`\n  Summary written → ${summaryPath}`);
    console.log(line);
  },
  7_200_000, // 2-hour timeout
);
