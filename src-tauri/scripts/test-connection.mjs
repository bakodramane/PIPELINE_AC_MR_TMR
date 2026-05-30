/**
 * API connection test — sidecar CLI wrapper.
 *
 * Invoked by the Tauri backend via tsx so TypeScript imports resolve:
 *   node <tsx-cli.mjs> test-connection.mjs --provider <id> --api-key <key>
 *
 * Arguments:
 *   --provider  deepseek | kimi | google | openai | anthropic
 *   --api-key   The API key to test
 *
 * Stdout protocol (exactly one line, then process exits 0):
 *   DONE:<latency_ms>   connection succeeded
 *   ERROR:<message>     connection failed
 *
 * Always exits with code 0 — errors are communicated via stdout.
 */

import path from "node:path";
import { fileURLToPath } from "node:url";
import { readFile } from "node:fs/promises";

// ---------------------------------------------------------------------------
// Path constants
// ---------------------------------------------------------------------------

// This file lives at <PIPELINE>/src-tauri/scripts/test-connection.mjs
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
  const result = { provider: null, apiKey: null };
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === "--provider") result.provider = argv[++i];
    else if (argv[i] === "--api-key")   result.apiKey  = argv[++i];
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

    if (!args.provider) {
      writeLine("ERROR:Missing required --provider argument");
      return;
    }
    if (!args.apiKey) {
      writeLine("ERROR:Missing required --api-key argument");
      return;
    }

    // Inject the key into process.env so provider modules can find it via
    // their standard env-var lookup.
    const PROVIDER_ENV_VARS = {
      deepseek:  "DEEPSEEK_API_KEY",
      kimi:      "KIMI_API_KEY",
      google:    "GOOGLE_API_KEY",
      openai:    "OPENAI_API_KEY",
      anthropic: "ANTHROPIC_API_KEY",
    };
    const envVar = PROVIDER_ENV_VARS[args.provider];
    if (envVar) process.env[envVar] = args.apiKey;
    // Kimi accepts both KIMI_API_KEY and MOONSHOT_API_KEY
    if (args.provider === "kimi") {
      process.env["MOONSHOT_API_KEY"] = args.apiKey;
    }

    let mod;
    try {
      // tsx registers a loader that resolves .ts extensions in dynamic imports
      mod = await import("../../src/providers/index.ts");
    } catch (err) {
      writeLine(`ERROR:Cannot load providers module: ${sanitise(String(err))}`);
      return;
    }

    const result = await mod.testApiConnection(args.provider, args.apiKey);
    if (result.success) {
      writeLine(`DONE:${result.latencyMs}`);
    } else {
      writeLine(`ERROR:${sanitise(result.error ?? "Unknown error")}`);
    }
  } catch (err) {
    writeLine(`ERROR:${sanitise(String(err))}`);
  }
}

void main().then(() => process.exit(0));
