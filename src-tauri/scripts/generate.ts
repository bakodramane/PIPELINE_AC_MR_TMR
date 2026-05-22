/**
 * AgCensus Compiler — generator CLI wrapper.
 *
 * Invoked by the Tauri backend as a child process to run MR/TMR generators.
 * Uses tsx (TypeScript runner) so all extensionless .ts imports resolve.
 *
 * Usage:
 *   node <tsx-cli.mjs> generate.ts \
 *     --project <absolute-project-dir> \
 *     --type    mr | tmr \
 *     --section  <1-15>  | --subtable <1-23>  | --all \
 *    [--model   <model-id>]
 *
 * Stdout protocol — one line per event, Rust reads these:
 *   STATUS:<message>          informational, shown in UI status bar
 *   DONE:<number>             section / sub-table completed successfully
 *   ERROR:<number>:<message>  section / sub-table failed
 *
 * Always exits 0 — errors are communicated via stdout, not exit code.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

// This file lives at  <PIPELINE>/src-tauri/scripts/generate.ts
// so __dirname  = <PIPELINE>/src-tauri/scripts
// and PIPELINE_ROOT = <PIPELINE>
const __filename = fileURLToPath(import.meta.url);
const __dirname  = path.dirname(__filename);
const PIPELINE_ROOT = path.resolve(__dirname, "..", "..");

// ---------------------------------------------------------------------------
// Model type (mirrors src/providers/types.ts — kept local to avoid import)
// ---------------------------------------------------------------------------

type Model =
  | "deepseek-v4-flash"
  | "deepseek-v4-pro"
  | "kimi-k2.6-non-thinking"
  | "kimi-k2.6-thinking";

// ---------------------------------------------------------------------------
// .env loader — sets missing process.env keys from <PIPELINE_ROOT>/.env
// ---------------------------------------------------------------------------

async function loadDotEnv(): Promise<void> {
  try {
    const envPath = path.join(PIPELINE_ROOT, ".env");
    const text = await readFile(envPath, "utf-8");
    for (const line of text.split(/\r?\n/)) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) continue;
      const eqIdx = trimmed.indexOf("=");
      if (eqIdx === -1) continue;
      const key = trimmed.slice(0, eqIdx).trim();
      // Strip optional surrounding single/double quotes from value
      const raw = trimmed.slice(eqIdx + 1).trim();
      const val = raw.replace(/^(["'])(.*)\1$/, "$2");
      if (key && !(key in process.env)) {
        process.env[key] = val;
      }
    }
  } catch {
    // .env absent or unreadable — rely solely on process.env
  }
}

// ---------------------------------------------------------------------------
// Argv parser
// ---------------------------------------------------------------------------

interface ParsedArgs {
  project?: string;
  type?: "mr" | "tmr";
  section?: number;
  subtable?: number;
  all: boolean;
  model: Model;
}

function parseArgs(argv: string[]): ParsedArgs {
  const result: ParsedArgs = { all: false, model: "deepseek-v4-flash" };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--project":
        result.project = argv[++i];
        break;
      case "--type":
        result.type = argv[++i] as "mr" | "tmr";
        break;
      case "--section":
        result.section = parseInt(argv[++i], 10);
        break;
      case "--subtable":
        result.subtable = parseInt(argv[++i], 10);
        break;
      case "--all":
        result.all = true;
        break;
      case "--model":
        result.model = argv[++i] as Model;
        break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Safe line writer (ensures newline-termination)
// ---------------------------------------------------------------------------

function writeLine(line: string): void {
  process.stdout.write(line.endsWith("\n") ? line : `${line}\n`);
}

function sanitise(msg: string): string {
  return msg.replace(/[\r\n]+/g, " ").slice(0, 400);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main(): Promise<void> {
  try {
    await loadDotEnv();

    const args = parseArgs(process.argv.slice(2));

    if (!args.project) {
      writeLine("ERROR:0:Missing required --project argument");
      return;
    }
    if (!args.type) {
      writeLine("ERROR:0:Missing required --type argument (mr | tmr)");
      return;
    }

    if (args.type === "mr") {
      // ── MR sections ─────────────────────────────────────────────────────
      let mrMod: { generateSection: (dir: string, n: number, model: Model) => Promise<void> };
      try {
        mrMod = await import("../../src/generators/mr");
      } catch (err) {
        writeLine(`ERROR:0:Cannot load MR generator: ${sanitise(String(err))}`);
        return;
      }
      const { generateSection } = mrMod;

      const targets: number[] =
        args.all
          ? Array.from({ length: 15 }, (_, i) => i + 1)
          : args.section != null
          ? [args.section]
          : [];

      if (targets.length === 0) {
        writeLine("ERROR:0:No sections specified — pass --section <n> or --all");
        return;
      }

      for (const n of targets) {
        writeLine(`STATUS:Generating MR section ${n} of ${args.all ? 15 : 1}…`);
        try {
          await generateSection(args.project, n, args.model);
          writeLine(`DONE:${n}`);
        } catch (err) {
          writeLine(`ERROR:${n}:${sanitise(String(err))}`);
        }
      }
    } else {
      // ── TMR sub-tables ───────────────────────────────────────────────────
      let tmrMod: { generateSubTable: (dir: string, n: number, model: Model) => Promise<void> };
      try {
        tmrMod = await import("../../src/generators/tmr");
      } catch (err) {
        writeLine(`ERROR:0:Cannot load TMR generator: ${sanitise(String(err))}`);
        return;
      }
      const { generateSubTable } = tmrMod;

      const targets: number[] =
        args.all
          ? Array.from({ length: 23 }, (_, i) => i + 1)
          : args.subtable != null
          ? [args.subtable]
          : [];

      if (targets.length === 0) {
        writeLine("ERROR:0:No sub-tables specified — pass --subtable <n> or --all");
        return;
      }

      for (const n of targets) {
        writeLine(`STATUS:Generating TMR sub-table ${n} of ${args.all ? 23 : 1}…`);
        try {
          await generateSubTable(args.project, n, args.model);
          writeLine(`DONE:${n}`);
        } catch (err) {
          writeLine(`ERROR:${n}:${sanitise(String(err))}`);
        }
      }
    }
  } catch (err) {
    // Top-level safety net — should not normally be reached
    writeLine(`ERROR:0:Fatal: ${sanitise(String(err))}`);
  }
}

void main().then(() => process.exit(0));
