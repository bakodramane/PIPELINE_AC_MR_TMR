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
  // Tier 1
  | "deepseek-v4-flash"
  | "gemini-2.0-flash"
  | "gpt-4o-mini"
  // Tier 2
  | "deepseek-v4-pro"
  | "kimi-k2.6"
  | "kimi-k2.6-thinking"
  | "gemini-2.5-flash"
  // Tier 3
  | "gpt-4o"
  | "gemini-2.5-pro"
  | "claude-opus-4-7"
  // Azure — FAO enterprise
  | "azure-gpt-4o"
  | "azure-gpt-4o-mini";

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
  type?: "mr" | "tmr" | "essential-items";
  section?: number;
  subtable?: number;
  item?: string;
  all: boolean;
  model: Model;
  provider?: string;
  apiKey?: string;
  azureEndpoint?: string;
  azureDeployment?: string;
}

// env-var name for each provider
const PROVIDER_ENV_VARS: Record<string, string> = {
  deepseek:  "DEEPSEEK_API_KEY",
  kimi:      "KIMI_API_KEY",
  google:    "GOOGLE_API_KEY",
  openai:    "OPENAI_API_KEY",
  anthropic: "ANTHROPIC_API_KEY",
  azure:     "AZURE_OPENAI_API_KEY",
};

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
      case "--item":
        result.item = argv[++i];
        break;
      case "--all":
        result.all = true;
        break;
      case "--model":
        result.model = argv[++i] as Model;
        break;
      case "--provider":
        result.provider = argv[++i];
        break;
      case "--api-key":
        result.apiKey = argv[++i];
        break;
      case "--azure-endpoint":
        result.azureEndpoint = argv[++i];
        break;
      case "--azure-deployment":
        result.azureDeployment = argv[++i];
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

    // Inject API key from --api-key arg into process.env so provider modules
    // can find it via their standard env-var lookup.  Only set if the env var
    // is not already present (allows .env file to take precedence in dev).
    if (args.apiKey && args.provider) {
      const envVar = PROVIDER_ENV_VARS[args.provider];
      if (envVar && !process.env[envVar]) {
        process.env[envVar] = args.apiKey;
      }
    }

    // Alias MOONSHOT_API_KEY → KIMI_API_KEY so either env var works
    if (!process.env["KIMI_API_KEY"] && process.env["MOONSHOT_API_KEY"]) {
      process.env["KIMI_API_KEY"] = process.env["MOONSHOT_API_KEY"];
    }

    // Inject Azure endpoint and deployment so provider module can read them
    if (args.provider === "azure") {
      if (args.azureEndpoint && !process.env["AZURE_OPENAI_ENDPOINT"]) {
        process.env["AZURE_OPENAI_ENDPOINT"] = args.azureEndpoint;
      }
      if (args.azureDeployment && !process.env["AZURE_OPENAI_DEPLOYMENT"]) {
        process.env["AZURE_OPENAI_DEPLOYMENT"] = args.azureDeployment;
      }
    }

    if (!args.project) {
      writeLine("ERROR:0:Missing required --project argument");
      return;
    }
    if (!args.type) {
      writeLine("ERROR:0:Missing required --type argument (mr | tmr | essential-items)");
      return;
    }

    if (args.type === "essential-items") {
      // ── Essential items assessment ─────────────────────────────────────────
      let eiMod: {
        assessEssentialItems: (
          dir: string,
          model: Model,
          itemCode: string | null,
          onProgress?: (index: number, code: string, ok: boolean, errorMsg?: string) => void,
        ) => Promise<void>;
      };
      try {
        eiMod = await import("../../src/generators/essential-items");
      } catch (err) {
        writeLine(`ERROR:0:Cannot load essential-items generator: ${sanitise(String(err))}`);
        return;
      }
      const { assessEssentialItems } = eiMod;
      const itemCode = args.item ?? null;
      writeLine(`STATUS:Assessing WCA 2020 essential items coverage${itemCode ? ` (item ${itemCode})` : ""}…`);
      try {
        await assessEssentialItems(
          args.project,
          args.model,
          itemCode,
          (index, code, ok, errorMsg) => {
            if (ok) {
              writeLine(`DONE:${index}`);
            } else {
              writeLine(`ERROR:${index}:${sanitise(errorMsg ?? `Assessment failed for ${code}`)}`);
            }
          },
        );
      } catch (err) {
        writeLine(`ERROR:0:${sanitise(String(err))}`);
      }
    } else if (args.type === "mr") {
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
    } else if (args.type === "tmr") {
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
