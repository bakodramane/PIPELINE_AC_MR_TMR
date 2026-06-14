/**
 * PDF → PageJson[] parser.
 *
 * Uses pdfjs-dist text extraction (getTextContent) — no canvas/rendering layer.
 * pdfjs-dist is dynamically imported so its module-level initialisation code
 * (which references browser globals like DOMMatrix) runs AFTER the host process
 * has already installed the required shims, avoiding a startup crash in bundled
 * production builds.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type { PageJson } from "../project/schema";

// Minimum character count below which we mark the page as low-confidence.
const OCR_THRESHOLD = 100;

// Confidence score for pages whose extracted text is suspiciously short.
const OCR_UNAVAILABLE_CONFIDENCE = 0.4;

// ---------------------------------------------------------------------------
// Heading detection
// ---------------------------------------------------------------------------

/**
 * Return lines from the page text that look like section headings.
 * Heuristic: short lines (≤ 100 chars) that start with a section number
 * ("1.", "2.3.") or are mostly upper-case.
 */
function detectHeadings(text: string): string[] {
  const headings: string[] = [];
  for (const raw of text.split("\n")) {
    const line = raw.trim();
    if (!line || line.length > 100) continue;
    const isNumbered = /^\d+(\.\d+)*\.?\s+\S/.test(line);
    const isCaps =
      line.length >= 4 &&
      line === line.toUpperCase() &&
      /[A-Z]/.test(line);
    if (isNumbered || isCaps) headings.push(line);
  }
  return headings;
}

// ---------------------------------------------------------------------------
// Text extraction via pdfjs-dist legacy build (no canvas / rendering)
// ---------------------------------------------------------------------------

/**
 * Extract text content page-by-page from a PDF buffer.
 *
 * Dynamic import delays pdfjs-dist initialisation until first call so the
 * DOMMatrix/ImageData/Path2D shims installed by the entry script are already
 * in place when pdfjs module-level code runs.
 */
async function extractTextByPage(buffer: Uint8Array): Promise<string[]> {
  // pdfjs-dist v5 tries to spawn a Node worker_threads worker to parse the PDF.
  // In a bundled environment the worker file (pdf.worker.mjs) does not exist
  // alongside the bundle, which crashes with "Cannot find module pdf.worker.mjs".
  //
  // Importing pdf.worker.mjs first makes esbuild bundle the worker code inline
  // and causes the worker to set globalThis.pdfjsWorker = { WorkerMessageHandler }.
  // pdfjs then detects that handler via its #mainThreadWorkerMessageHandler getter
  // (which reads globalThis.pdfjsWorker?.WorkerMessageHandler) and runs the PDF
  // parser in the main thread instead of spawning a separate worker file.
  await import("pdfjs-dist/legacy/build/pdf.worker.mjs");

  const pdfjsLib = await import("pdfjs-dist/legacy/build/pdf.mjs");

  // Belt-and-suspenders: clear workerSrc so the fallback path cannot resolve
  // an external file even if #mainThreadWorkerMessageHandler check is bypassed.
  if (pdfjsLib.GlobalWorkerOptions) {
    pdfjsLib.GlobalWorkerOptions.workerSrc = "";
  }

  const loadingTask = pdfjsLib.getDocument({
    data: buffer,
    disableFontFace: true,
    useSystemFonts: false,
    isEvalSupported: false,
  });
  const pdf = await loadingTask.promise;
  const texts: string[] = [];
  for (let i = 1; i <= pdf.numPages; i++) {
    const page = await pdf.getPage(i);
    const content = await page.getTextContent();
    const text = content.items
      .map((item) => ("str" in item ? (item as { str: string }).str : ""))
      .join(" ");
    texts.push(text);
  }
  await pdf.destroy();
  return texts;
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parse a PDF file and return one PageJson per page.
 *
 * @param pdfPath      Absolute or relative path to the PDF file.
 * @param sourceDocId  The id that will become page_id prefix and source_doc.
 * @param language     BCP-47 language tag for the document (default "en").
 */
export async function parsePdf(
  pdfPath: string,
  sourceDocId: string,
  language = "en",
): Promise<PageJson[]> {
  const absPath = path.resolve(pdfPath);
  const buffer = await readFile(absPath);

  const pageTexts = await extractTextByPage(new Uint8Array(buffer));
  const totalPages = pageTexts.length;

  const pages: PageJson[] = [];
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const rawText = pageTexts[pageNum - 1] ?? "";
    const isShort = rawText.trim().length < OCR_THRESHOLD;

    // Page id format: "{sourceDocId}-p{pageNum:04d}"
    const pageId = `${sourceDocId}-p${String(pageNum).padStart(4, "0")}`;

    const page: PageJson = {
      page_id: pageId,
      source_doc: sourceDocId,
      page_number: pageNum,
      text: rawText,
      headings: detectHeadings(rawText),
      tables_on_page: [], // populated by the pipeline after table extraction
      language,
    };
    if (isShort) {
      page.extraction_confidence = OCR_UNAVAILABLE_CONFIDENCE;
    }
    pages.push(page);
  }

  return pages;
}
