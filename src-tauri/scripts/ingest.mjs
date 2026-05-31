/**
 * AgCensus Compiler â€” PDF ingest CLI wrapper.
 *
 * Invoked by the Tauri backend (ingest_source command) via tsx:
 *   node <tsx-cli.mjs> ingest.mjs \
 *     --project  <absolute-project-dir> \
 *     --doc-id   <doc-id>              \
 *     --file     <absolute-pdf-path>   \
 *     --language <bcp47-code>
 *
 * Stdout protocol (one line, then process exits 0):
 *   DONE:<page_count>    ingestion completed successfully
 *   ERROR:<message>      ingestion failed
 *
 * Always exits with code 0 â€” errors are communicated via stdout.
 */

import path from "node:path";
import { createHash } from "node:crypto";
import { readFile, writeFile } from "node:fs/promises";
// Static import — resolved at bundle time by esbuild; no tsx needed at runtime.
import { ingestPdf, ingestExcel } from "../../src/ingest/pipeline.ts";

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
  const result = { language: "en" };
  for (let i = 0; i < argv.length; i++) {
    switch (argv[i]) {
      case "--project":  result.project  = argv[++i]; break;
      case "--doc-id":   result.docId    = argv[++i]; break;
      case "--file":     result.file     = argv[++i]; break;
      case "--language": result.language = argv[++i]; break;
    }
  }
  return result;
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

async function main() {
  try {
    const args = parseArgs(process.argv.slice(2));

    if (!args.project || !args.docId || !args.file) {
      writeLine("ERROR:Missing required arguments: --project, --doc-id, --file");
      return;
    }

    // Detect file type by extension and run the matching ingester.
    // Excel (.xlsx / .xls) is indexed one TableJson + PageJson per sheet;
    // PDF is indexed one PageJson per page. The DONE count below reflects
    // sheets for Excel and pages for PDF (both counted from the evidence index).
    const ext = path.extname(args.file).toLowerCase();
    if (ext === ".xlsx" || ext === ".xls") {
      await ingestExcel(args.project, args.docId, args.file, args.language);
    } else {
      await ingestPdf(args.project, args.docId, args.file, args.language);
    }

    // Count pages indexed for this document by reading the evidence index
    const evidenceRaw = await readFile(
      path.join(args.project, "evidence", "_evidence.json"),
      "utf-8"
    );
    const evidence = JSON.parse(evidenceRaw);
    const pageCount = evidence.pages.filter(
      (p) => p.source_doc === args.docId
    ).length;

    // Compute SHA-256 of the copied file
    const fileBuf = await readFile(args.file);
    const sha256 = createHash("sha256").update(fileBuf).digest("hex");

    // Upsert sources/_index.json (remove old entry for this id, add new one)
    const indexPath = path.join(args.project, "sources", "_index.json");
    let index;
    try {
      index = JSON.parse(await readFile(indexPath, "utf-8"));
    } catch {
      index = [];
    }
    index = index.filter((e) => e.id !== args.docId);
    index.push({
      id: args.docId,
      filename: path.basename(args.file),
      url: "",
      retrieved: new Date().toISOString().slice(0, 10),
      sha256,
      language: args.language,
      page_count: pageCount,
      description: path.basename(args.file),
    });
    await writeFile(indexPath, JSON.stringify(index, null, 2) + "\n", "utf-8");

    // Upsert manifest.json source_documents array
    const manifestPath = path.join(args.project, "manifest.json");
    const manifest = JSON.parse(await readFile(manifestPath, "utf-8"));
    manifest.source_documents = (manifest.source_documents ?? []).filter(
      (d) => d.id !== args.docId
    );
    manifest.source_documents.push({
      id: args.docId,
      title: path.basename(args.file),
      url: "",
      retrieved: new Date().toISOString().slice(0, 10),
      language: args.language,
    });
    await writeFile(
      manifestPath,
      JSON.stringify(manifest, null, 2) + "\n",
      "utf-8"
    );

    writeLine(`DONE:${pageCount}`);
  } catch (err) {
    writeLine(`ERROR:${sanitise(String(err))}`);
  }
}

void main().then(() => process.exit(0));
