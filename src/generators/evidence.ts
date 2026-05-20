/**
 * Evidence retrieval for MR/TMR generators.
 *
 * Reads the evidence index and returns the most relevant PageJson objects for
 * a given set of keywords. Relevance is scored by:
 *   1. Keyword overlap with the page's pre-built keywords[] from the index.
 *   2. Heading overlap (weighted 2×).
 *   3. Full-text substring match once the page is loaded (also used to filter
 *      out blank/image-only pages whose text.length < 100).
 *
 * No embeddings, no network — pure in-process string matching.
 *
 * Constraints:
 *  - All paths use path.join() — no hardcoded separators.
 *  - All file I/O uses fs/promises — no sync calls.
 */

import { readFile } from "node:fs/promises";
import path from "node:path";
import type {
  EvidenceIndex,
  EvidencePageSummary,
  PageJson,
} from "../project/schema";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

/**
 * Score a page summary against the query keywords using only the index fields
 * (keywords[] and headings[]). No I/O required.
 *
 * Returns 0 when there is no overlap at all.
 */
function scoreFromIndex(
  summary: EvidencePageSummary,
  normalizedKeywords: string[],
): number {
  const kwLower = summary.keywords.map((k) => k.toLowerCase());
  const headingsLower = summary.headings.map((h) => h.toLowerCase());

  let score = 0;
  for (const kw of normalizedKeywords) {
    // keywords[] — base weight 1
    if (kwLower.some((k) => k.includes(kw))) score += 1;
    // headings — higher weight (headings are strong topical signals)
    if (headingsLower.some((h) => h.includes(kw))) score += 2;
  }
  return score;
}

/**
 * Score a page's full text against the query keywords.
 * Used as a second-pass refinement once the page file has been loaded.
 */
function scoreFromText(text: string, normalizedKeywords: string[]): number {
  const textLower = text.toLowerCase();
  let score = 0;
  for (const kw of normalizedKeywords) {
    if (textLower.includes(kw)) score += 1;
  }
  return score;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Retrieve the most relevant pages from a project's evidence store.
 *
 * @param projectDir  Absolute path to the country project directory.
 * @param keywords    Query terms (case-insensitive substring matching).
 * @param maxPages    Maximum number of pages to return (default 20).
 *
 * @returns Sorted array of PageJson objects, most relevant first.
 *          Returns an empty array (never throws) if the index is missing or
 *          no pages match.
 */
export async function retrieveEvidence(
  projectDir: string,
  keywords: string[],
  maxPages = 20,
): Promise<PageJson[]> {
  // ── 1. Load evidence index ──────────────────────────────────────────────
  const indexPath = path.join(projectDir, "evidence", "_evidence.json");
  let index: EvidenceIndex;
  try {
    index = await readJson<EvidenceIndex>(indexPath);
  } catch {
    return []; // index missing — nothing to retrieve
  }

  if (index.pages.length === 0) return [];

  const normalizedKeywords = keywords.map((k) => k.toLowerCase());

  // ── 2. Pass 1: score all pages from the index (no I/O) ─────────────────
  const indexScored = index.pages.map((summary) => ({
    summary,
    indexScore: scoreFromIndex(summary, normalizedKeywords),
  }));

  // Sort descending by index score; take the top 2×maxPages candidates that
  // have any index score.  If no page scores at all, fall back to the first
  // 2×maxPages pages (some evidence is better than none).
  indexScored.sort((a, b) => b.indexScore - a.indexScore);

  const hasAnyIndexScore = indexScored.some((s) => s.indexScore > 0);
  const candidates = hasAnyIndexScore
    ? indexScored.filter((s) => s.indexScore > 0).slice(0, maxPages * 2)
    : indexScored.slice(0, maxPages * 2);

  // ── 3. Pass 2: load page files, filter blanks, re-score on text ─────────
  const pagesDir = path.join(projectDir, "evidence", "pages");
  const result: { page: PageJson; score: number }[] = [];

  for (const { summary, indexScore } of candidates) {
    const pagePath = path.join(pagesDir, `${summary.page_id}.json`);
    let page: PageJson;
    try {
      page = await readJson<PageJson>(pagePath);
    } catch {
      continue; // page file missing — skip
    }

    // Filter blank / image-only pages
    if (page.text.length < 100) continue;

    const textScore = scoreFromText(page.text, normalizedKeywords);
    result.push({ page, score: indexScore + textScore });
  }

  // ── 4. Sort by combined score and return top maxPages ───────────────────
  result.sort((a, b) => b.score - a.score);
  return result.slice(0, maxPages).map((r) => r.page);
}
