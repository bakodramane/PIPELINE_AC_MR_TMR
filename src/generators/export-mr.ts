/**
 * MR Markdown export generator.
 *
 * Reads drafts/mr/_claims.json and manifest.json, then produces a Markdown
 * document with all 15 MR sections in order.  Each section shows its
 * evidence-backed claims with source references.  Sections with no claims
 * get the standard WCA "not available" boilerplate.
 *
 * Format per section:
 *
 *   ### <n>. <Title>
 *
 *   <claim text>
 *   > Source: <page_id>, p.<page_number>
 *
 *   ---
 *
 * Output: exports/<country_iso3>-mr-<YYYY-MM-DD>.md
 *
 * export async function exportMr(projectDir: string): Promise<string>
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import type { Manifest, ClaimsJson } from "../project/schema";
import { MR_SECTION_TITLES } from "../types/ui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

/**
 * Extract page number from a page_id like "01-main-report-p014" → "14".
 * The page_id format is <doc-id>-p<zero-padded-number>.
 * Returns "?" when the pattern is not recognised.
 */
function extractPageNum(pageId: string): string {
  const match = pageId.match(/-p0*(\d+)$/);
  return match ? String(parseInt(match[1], 10)) : "?";
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Export the MR to Markdown.
 *
 * @param projectDir  Absolute path to the country project directory.
 * @param clean       When true, all sections that have generated claims are shown
 *                    (approval status is irrelevant — approval is a separate workflow
 *                    that does not gate the export).  The output filename has no
 *                    `-draft` suffix and is suitable for external distribution.
 *                    When false (default), the same content is included but the
 *                    filename carries a `-draft` suffix to flag it as internal.
 */
export async function exportMr(projectDir: string, clean = false): Promise<string> {
  // ── Read inputs ──────────────────────────────────────────────────────────
  const manifest = await readJson<Manifest>(path.join(projectDir, "manifest.json"));

  let claimsJson: ClaimsJson = {};
  try {
    claimsJson = await readJson<ClaimsJson>(
      path.join(projectDir, "drafts", "mr", "_claims.json"),
    );
  } catch {
    // _claims.json absent — all sections will show "not available" boilerplate
  }

  // ── Build Markdown document ──────────────────────────────────────────────
  const today = new Date().toISOString().slice(0, 10);

  let md = `# ${manifest.country} — ${manifest.census_name}\n\n`;
  md += `## Metadata Review\n\n`;
  md += `Generated: ${today}\n\n`;
  md += `---\n\n`;

  for (let n = 1; n <= 15; n++) {
    const title = MR_SECTION_TITLES[n] ?? `Section ${n}`;
    md += `### ${n}. ${title}\n\n`;

    const sectionData = claimsJson[`section_${n}`];

    // Show "not available" only when the generator found no sourceable content
    // for this section (zero claims).  Approval status does not gate the export.
    if (!sectionData || sectionData.claims.length === 0) {
      md +=
        `*Information on this point was not available in the source documents provided.*\n\n`;
    } else {
      for (const claim of sectionData.claims) {
        md += `${claim.text}\n`;
        for (const src of claim.sources) {
          const pageNum = extractPageNum(src.page_id);
          md += `> Source: ${src.page_id}, p.${pageNum}\n`;
        }
        md += `\n`;
      }
    }

    if (n < 15) {
      md += `---\n\n`;
    }
  }

  // ── Write output file ─────────────────────────────────────────────────────
  const outputDir = path.join(projectDir, "exports");
  await mkdir(outputDir, { recursive: true });
  // Draft files get a -draft suffix; clean (final) files do not.
  const suffix   = clean ? "" : "-draft";
  const filename = `${manifest.country_iso3.toLowerCase()}-mr-${today}${suffix}.md`;
  const outputPath = path.join(outputDir, filename);

  await writeFile(outputPath, md, "utf-8");
  return outputPath;
}
