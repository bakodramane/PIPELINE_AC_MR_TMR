/**
 * Pre-compile sidecar scripts into standalone CJS bundles.
 *
 * Run before `tauri build` so the installer can ship pre-compiled scripts
 * instead of relying on tsx + source files at runtime.
 *
 * Output: dist-scripts/generate.cjs, ingest.cjs, export.cjs, test-connection.cjs
 *
 * Also copies runtime data files (prompt templates, WCA concepts) into
 * dist-scripts/ so production bundles can locate them via AGCENSUS_RESOURCE_ROOT.
 *
 * External packages (tesseract.js, pdf-parse, xlsx, docx) are kept external
 * because they contain WASM binaries or native add-ons.  They are shipped as
 * Tauri resources under node_modules/ so Node can find them at runtime.
 * @anthropic-ai/sdk is bundled directly — it is pure JS with only Node built-ins.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import path from 'path';
import fs from 'fs';
import { createWriteStream } from 'fs';

// archiver is CommonJS — use createRequire to load it from an ESM file
const require = createRequire(import.meta.url);
const archiver = require('archiver');

const __dirname = path.dirname(fileURLToPath(import.meta.url));
const ROOT = path.resolve(__dirname, '..');
const OUT  = path.join(ROOT, 'dist-scripts');

// Clean output directory to avoid stale artifacts
if (fs.existsSync(OUT)) fs.rmSync(OUT, { recursive: true });
fs.mkdirSync(OUT);

// ---------------------------------------------------------------------------
// JS/TS bundles
// ---------------------------------------------------------------------------

// ESM format: `import.meta.url` resolves correctly and Node handles external
// CJS packages transparently via dynamic import interop (Node 12+).
// Output uses .mjs extension so Node treats the files as ES modules.
//
// Only tesseract.js is external (contains WASM worker binaries that cannot
// be embedded in a JS bundle).  docx, xlsx, and pdf-parse are pure JS and
// are bundled directly, making the install self-contained without requiring
// those packages in node_modules at runtime.
const shared = {
  bundle:   true,
  platform: 'node',
  format:   'esm',
  target:   'node18',
  outdir:   OUT,
  outExtension: { '.js': '.mjs' },
  // tesseract.js ships WASM worker files that cannot be bundled — keep external.
  // The OCR fallback path requires tesseract.js to exist in node_modules at runtime;
  // all other packages (docx, xlsx, pdf-parse) are bundled directly.
  external: ['tesseract.js'],
  loader: { '.ts': 'ts', '.mjs': 'js' },
};

await Promise.all([
  build({ ...shared, entryPoints: [path.join(ROOT, 'src-tauri/scripts/generate.ts')]         }),
  build({ ...shared, entryPoints: [path.join(ROOT, 'src-tauri/scripts/ingest.mjs')]          }),
  build({ ...shared, entryPoints: [path.join(ROOT, 'src-tauri/scripts/export.mjs')]          }),
  build({ ...shared, entryPoints: [path.join(ROOT, 'src-tauri/scripts/test-connection.mjs')] }),
]);

console.log('Bundles written to dist-scripts/');

// ---------------------------------------------------------------------------
// Runtime data files
// ---------------------------------------------------------------------------
// The bundled scripts compute file paths using AGCENSUS_RESOURCE_ROOT (set by
// the Rust backend in production) or fall back to __dirname-relative paths in
// dev mode.  Copy the data files into dist-scripts/ so Tauri can bundle them
// as a single resource glob.
// ---------------------------------------------------------------------------

function ensureDir(dir) {
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
}

function copyFile(src, dst) {
  ensureDir(path.dirname(dst));
  fs.copyFileSync(src, dst);
}

function copyDir(srcDir, dstDir) {
  ensureDir(dstDir);
  for (const entry of fs.readdirSync(srcDir, { withFileTypes: true })) {
    const srcPath = path.join(srcDir, entry.name);
    const dstPath = path.join(dstDir, entry.name);
    if (entry.isDirectory()) {
      copyDir(srcPath, dstPath);
    } else {
      fs.copyFileSync(srcPath, dstPath);
    }
  }
}

// MR section prompt files (read by mr.ts at runtime)
copyDir(
  path.join(ROOT, 'src', 'generators', 'mr-prompts'),
  path.join(OUT, 'mr-prompts'),
);

// MR system prompt (read by mr.ts at runtime)
copyFile(
  path.join(ROOT, 'references', 'mr-prompt-v1.3.md'),
  path.join(OUT, 'references', 'mr-prompt-v1.3.md'),
);

// WCA 2020 concept registry (read by tmr.ts at runtime)
copyFile(
  path.join(ROOT, 'src', 'concepts', 'wca-2020.json'),
  path.join(OUT, 'concepts', 'wca-2020.json'),
);

console.log('Data files copied to dist-scripts/');

// ---------------------------------------------------------------------------
// Portable ZIP (only when --portable flag is passed)
// ---------------------------------------------------------------------------

if (process.argv.includes('--portable')) {
  const distDir = path.join(ROOT, 'dist');
  if (!fs.existsSync(distDir)) fs.mkdirSync(distDir);

  const exePath = path.join(ROOT, 'src-tauri', 'target', 'release', 'agcensus-compiler.exe');
  if (!fs.existsSync(exePath)) {
    console.error('ERROR: Release binary not found. Run tauri build first.');
    process.exit(1);
  }

  const zipPath = path.join(distDir, 'AgCensus-Compiler-portable-win.zip');
  const output = createWriteStream(zipPath);
  const archive = archiver('zip', { zlib: { level: 9 } });

  archive.pipe(output);
  archive.file(exePath, { name: 'agcensus-compiler.exe' });
  archive.directory(path.join(ROOT, 'dist-scripts'), 'dist-scripts');

  await new Promise((resolve, reject) => {
    output.on('close', resolve);
    archive.on('error', reject);
    archive.finalize();
  });

  console.log(`Portable ZIP written to ${zipPath} (${Math.round(archive.pointer() / 1024 / 1024)} MB)`);
}
