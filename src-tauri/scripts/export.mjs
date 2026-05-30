/**
 * AgCensus Compiler — export CLI wrapper.
 *
 * Invoked by the Tauri backend via tsx so TypeScript imports resolve:
 *   node <tsx-cli.mjs> export.mjs --project <dir> --type tmr|mr
 *
 * Arguments:
 *   --project  Absolute path to the country project directory
 *   --type     "tmr"  → writes exports/<iso3>-tmr-<date>.xlsx
 *              "mr"   → writes exports/<iso3>-mr-<date>.md
 *
 * Stdout protocol (exactly one line, then process exits 0):
 *   DONE:<absolute-output-path>   export succeeded
 *   ERROR:<message>               export failed
 *
 * Always exits with code 0 — errors are communicated via stdout.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

// This file lives at <PIPELINE>/src-tauri/scripts/export.mjs
// __dirname  = <PIPELINE>/src-tauri/scripts
// PIPELINE_ROOT = <PIPELINE>
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PIPELINE_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// .env loader
// ---------------------------------------------------------------------------

async function loadDotEnv() {
  try {
    const envPath = path.join(PIPELINE_ROOT, ".env");
    const text = await readFile(envPath, "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      const raw = trimmed.slice(eqIdx + 1).trim();
      const val = raw.replace(/^(["'])(.*)\1$/, "$2");
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env absent or unreadable — rely on process.env
  }
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function writeLine(line) {
  process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
}

function sanitise(msg) {
  return String(msg).replace(/[\r\n]+/g, " ").slice(0, 400);
}

function parseArgs(argv) {
  const result = { project: null, type: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--project") result.project = argv[++i];
    else if (argv[i] === "--type") result.type = argv[++i];
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    await loadDotEnv();
    const args = parseArgs(process.argv.slice(2));

    if (!args.project) {
      writeLine("ERROR:Missing required --project argument");
      return;
    }
    const VALID_TYPES = ["tmr", "mr", "mr-draft", "mr-docx", "mr-docx-draft", "mr-clean", "mr-docx-clean"];
    if (!VALID_TYPES.includes(args.type)) {
      writeLine(`ERROR:Missing or invalid --type argument — must be one of: ${VALID_TYPES.join(", ")}`);
      return;
    }

    if (args.type === "tmr") {
      let mod;
      try {
        // tsx registers a loader that resolves .ts extensions in dynamic imports
        mod = await import("../../src/generators/export-tmr.ts");
      } catch (err) {
        writeLine(`ERROR:Cannot load TMR export module: ${sanitise(String(err))}`);
        return;
      }
      const outputPath = await mod.exportTmr(args.project);
      writeLine(`DONE:${outputPath}`);
    } else if (args.type === "mr-docx" || args.type === "mr-docx-draft") {
      // mr-docx and mr-docx-draft → draft DOCX (clean = false)
      let mod;
      try {
        mod = await import("../../src/generators/export-mr-docx.ts");
      } catch (err) {
        writeLine(`ERROR:Cannot load MR DOCX export module: ${sanitise(String(err))}`);
        return;
      }
      const outputPath = await mod.exportMrDocx(args.project, false);
      writeLine(`DONE:${outputPath}`);
    } else if (args.type === "mr-docx-clean") {
      // mr-docx-clean → approved-only DOCX (clean = true)
      let mod;
      try {
        mod = await import("../../src/generators/export-mr-docx.ts");
      } catch (err) {
        writeLine(`ERROR:Cannot load MR DOCX export module: ${sanitise(String(err))}`);
        return;
      }
      const outputPath = await mod.exportMrDocx(args.project, true);
      writeLine(`DONE:${outputPath}`);
    } else if (args.type === "mr-clean") {
      // mr-clean → approved-only Markdown (clean = true)
      let mod;
      try {
        mod = await import("../../src/generators/export-mr.ts");
      } catch (err) {
        writeLine(`ERROR:Cannot load MR export module: ${sanitise(String(err))}`);
        return;
      }
      const outputPath = await mod.exportMr(args.project, true);
      writeLine(`DONE:${outputPath}`);
    } else {
      // mr and mr-draft → draft Markdown (clean = false)
      let mod;
      try {
        mod = await import("../../src/generators/export-mr.ts");
      } catch (err) {
        writeLine(`ERROR:Cannot load MR export module: ${sanitise(String(err))}`);
        return;
      }
      const outputPath = await mod.exportMr(args.project, false);
      writeLine(`DONE:${outputPath}`);
    }
  } catch (err) {
    writeLine(`ERROR:${sanitise(String(err))}`);
  }
}

void main().then(() => process.exit(0));
