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
 * @anthropic-ai/sdk is bundled directly ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â it is pure JS with only Node built-ins.
 */

import { build } from 'esbuild';
import { fileURLToPath } from 'url';
import { createRequire } from 'module';
import { execSync } from 'child_process';
import path from 'path';
import fs from 'fs';
import { createWriteStream } from 'fs';

// archiver is CommonJS ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â use createRequire to load it from an ESM file
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
  // tesseract.js ships WASM worker files that cannot be bundled ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Â ÃƒÂ¢Ã¢â€šÂ¬Ã¢â€žÂ¢ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã¢â‚¬Â¦Ãƒâ€šÃ‚Â¡ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™Ãƒâ€ Ã¢â‚¬â„¢ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã†â€™Ãƒâ€šÃ‚Â¢ÃƒÆ’Ã‚Â¢ÃƒÂ¢Ã¢â‚¬Å¡Ã‚Â¬Ãƒâ€¦Ã‚Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â¬ÃƒÆ’Ã†â€™ÃƒÂ¢Ã¢â€šÂ¬Ã…Â¡ÃƒÆ’Ã¢â‚¬Å¡Ãƒâ€šÃ‚Â keep external.
  // The OCR fallback path requires tesseract.js to exist in node_modules at runtime;
  // all other packages (docx, xlsx, pdf-parse) are bundled directly.
  // tesseract.js: WASM worker files cannot be bundled.
  // @napi-rs/canvas, canvas: native add-ons; pdfjs-dist tries to require() them
  //   for rendering polyfills but text extraction never uses them.  Marking them
  //   external prevents esbuild from attempting to bundle a .node binary.
  external: ['tesseract.js', '@napi-rs/canvas', 'canvas'],
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

  const exePath = path.join(process.env.CARGO_TARGET_DIR || path.join(ROOT, 'src-tauri', 'target'), 'release', 'agcensus-compiler.exe');
  if (!fs.existsSync(exePath)) {
    console.error('ERROR: Release binary not found. Run tauri build first.');
    process.exit(1);
  }

  // Find node.exe on the developer's machine
  let nodeExePath;
  try {
    nodeExePath = execSync('where node', { encoding: 'utf8' })
      .trim().split('\n')[0].trim();
    if (!nodeExePath.endsWith('.exe') && !nodeExePath.includes('node')) {
      throw new Error('node not found');
    }
    console.log(`Bundling node.exe from: ${nodeExePath}`);
  } catch {
    console.error('ERROR: node.exe not found on PATH. Cannot create self-contained portable ZIP.');
    process.exit(1);
  }

  const zipPath = path.join(distDir, 'AgCensus-MR-TMR-Compiler-portable-win.zip');
  const stagingDir = path.join(ROOT, 'dist', 'portable-staging');
  if (fs.existsSync(stagingDir)) fs.rmSync(stagingDir, { recursive: true });
  fs.mkdirSync(stagingDir, { recursive: true });
  fs.copyFileSync(exePath, path.join(stagingDir, 'agcensus-compiler.exe'));
  fs.copyFileSync(nodeExePath, path.join(stagingDir, 'node.exe'));
  fs.cpSync(path.join(ROOT, 'dist-scripts'), path.join(stagingDir, 'dist-scripts'), { recursive: true });
  if (fs.existsSync(zipPath)) fs.unlinkSync(zipPath);
  execSync('powershell -Command "Compress-Archive -Path \\"' + stagingDir + '\\\\*\\" -DestinationPath \\"' + zipPath + '\\" -Force"', { stdio: 'inherit' });
  fs.rmSync(stagingDir, { recursive: true });
  const zipSize = Math.round(fs.statSync(zipPath).size / 1024 / 1024);
  console.log('Portable ZIP written to ' + zipPath + ' (' + zipSize + ' MB)');
}
