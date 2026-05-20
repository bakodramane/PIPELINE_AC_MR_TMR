/**
 * PDF → PageJson[] parser.
 *
 * Primary path: pdf-parse v2 getText() for text PDFs.
 * Fallback path: tesseract.js OCR for pages whose extracted text is suspiciously
 *   short (< 100 characters), using pdf-parse v2 getScreenshot() to obtain the
 *   PNG buffer that tesseract needs — no separate canvas dependency required.
 *
 * Constraints:
 *  - All paths use path.join() — no hardcoded separators.
 *  - All file I/O uses fs/promises — no sync calls.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import { PDFParse } from "pdf-parse";
import type { PageJson } from "../project/schema";

// Minimum character count below which we attempt OCR on a page.
const OCR_THRESHOLD = 100;

// Confidence score assigned when OCR succeeded.
const OCR_SUCCESS_CONFIDENCE_MAX = 0.68; // always below 0.7 per spec

// Confidence score assigned when OCR was attempted but unavailable / failed.
const OCR_UNAVAILABLE_CONFIDENCE = 0.40;

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
// OCR fallback
// ---------------------------------------------------------------------------

/**
 * Attempt OCR on a single PDF page using tesseract.js.
 *
 * Requires the page PNG buffer (obtained from pdf-parse getScreenshot).
 * Returns null if tesseract is unavailable or the call fails.
 */
async function ocrPageBuffer(
  pngBuffer: Uint8Array,
): Promise<{ text: string; confidence: number } | null> {
  try {
    const { createWorker } = await import("tesseract.js");
    const worker = await createWorker("eng", undefined, {
      // Suppress verbose tesseract logging in non-debug environments
      logger: () => undefined,
      errorHandler: () => undefined,
    });
    const result = await worker.recognize(Buffer.from(pngBuffer));
    await worker.terminate();
    const confidence =
      Math.min(result.data.confidence / 100, 1) * OCR_SUCCESS_CONFIDENCE_MAX;
    return { text: result.data.text.trim(), confidence };
  } catch {
    // tesseract or language data unavailable
    return null;
  }
}

// ---------------------------------------------------------------------------
// Main export
// ---------------------------------------------------------------------------

/**
 * Parse a PDF file and return one PageJson per page.
 *
 * @param pdfPath   Absolute or relative path to the PDF file.
 * @param sourceDocId  The id that will become page_id prefix and source_doc.
 * @param language  BCP-47 language tag for the document (default "en").
 */
export async function parsePdf(
  pdfPath: string,
  sourceDocId: string,
  language = "en",
): Promise<PageJson[]> {
  const absPath = path.resolve(pdfPath);
  const buffer = await readFile(absPath);

  const parser = new PDFParse({ data: buffer });

  // 1. Extract text for all pages
  const textResult = await parser.getText();
  const totalPages = textResult.total as number;

  // Build a map of page number → text
  const pageTextMap = new Map<number, string>();
  for (const p of textResult.pages as { num: number; text: string }[]) {
    pageTextMap.set(p.num, p.text);
  }

  // Identify pages that need OCR (text too short)
  const needOcr: number[] = [];
  for (const [num, text] of pageTextMap) {
    if (text.trim().length < OCR_THRESHOLD) needOcr.push(num);
  }

  // 2. Get screenshots only for pages needing OCR
  const ocrResults = new Map<number, { text: string; confidence: number }>();

  if (needOcr.length > 0) {
    try {
      const screenshots = await parser.getScreenshot({
        partial: needOcr,
      });
      const pages = screenshots.pages as unknown as { num: number; data: Uint8Array }[];

      // Process OCR sequentially to avoid spawning too many workers
      for (const screenshotPage of pages) {
        const ocr = await ocrPageBuffer(screenshotPage.data);
        if (ocr) {
          ocrResults.set(screenshotPage.num, ocr);
        } else {
          ocrResults.set(screenshotPage.num, {
            text: pageTextMap.get(screenshotPage.num) ?? "",
            confidence: OCR_UNAVAILABLE_CONFIDENCE,
          });
        }
      }
    } catch {
      // getScreenshot unavailable (e.g., missing rendering support)
      for (const num of needOcr) {
        ocrResults.set(num, {
          text: pageTextMap.get(num) ?? "",
          confidence: OCR_UNAVAILABLE_CONFIDENCE,
        });
      }
    }
  }

  await parser.destroy();

  // 3. Assemble PageJson array, one entry per page
  const pages: PageJson[] = [];
  for (let pageNum = 1; pageNum <= totalPages; pageNum++) {
    const rawText = pageTextMap.get(pageNum) ?? "";
    const isShort = rawText.trim().length < OCR_THRESHOLD;

    let finalText: string;

    if (isShort && ocrResults.has(pageNum)) {
      const ocr = ocrResults.get(pageNum)!;
      finalText = ocr.text || rawText;
    } else {
      finalText = rawText;
    }

    // Page id format: "{sourceDocId}-p{pageNum:04d}"
    const pageId = `${sourceDocId}-p${String(pageNum).padStart(4, "0")}`;

    pages.push({
      page_id: pageId,
      source_doc: sourceDocId,
      page_number: pageNum,
      text: finalText,
      headings: detectHeadings(finalText),
      tables_on_page: [], // populated by the pipeline after table extraction
      language,
    });
  }

  return pages;
}
