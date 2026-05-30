/**
 * MR Word (.docx) export generator.
 *
 * Reads drafts/mr/_claims.json and manifest.json, then produces a Word document
 * with all 15 MR sections.  Evidence-backed claims are listed with source refs;
 * empty sections show the standard WCA "not available" boilerplate.
 *
 * Output: exports/<country_iso3>-mr-<YYYY-MM-DD>.docx
 *
 * export async function exportMrDocx(projectDir: string): Promise<string>
 */

import { readFile, writeFile, mkdir } from "node:fs/promises";
import path from "node:path";
import {
  AlignmentType,
  BorderStyle,
  Document,
  Footer,
  HeadingLevel,
  Packer,
  PageNumber,
  Paragraph,
  TextRun,
} from "docx";
import type { Manifest, ClaimsJson } from "../project/schema";
import { MR_SECTION_TITLES } from "../types/ui";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

const FAO_GREEN = "1B4F23";
const GREY = "808080";
const RULE_COLOUR = "CCCCCC";

function hRule(): Paragraph {
  return new Paragraph({
    border: {
      bottom: { style: BorderStyle.SINGLE, size: 6, color: RULE_COLOUR },
    },
    spacing: { before: 120, after: 120 },
    children: [],
  });
}

// ---------------------------------------------------------------------------
// Export
// ---------------------------------------------------------------------------

/**
 * Export the MR to Word (.docx).
 *
 * @param projectDir  Absolute path to the country project directory.
 * @param clean       When true, all sections that have generated claims are shown
 *                    (approval status is irrelevant — approval is a separate workflow
 *                    that does not gate the export).  The output filename has no
 *                    `-draft` suffix and is suitable for external distribution.
 *                    When false (default), the same content is included but the
 *                    filename carries a `-draft` suffix to flag it as internal.
 */
export async function exportMrDocx(projectDir: string, clean = false): Promise<string> {
  const manifest = await readJson<Manifest>(
    path.join(projectDir, "manifest.json"),
  );

  let claimsJson: ClaimsJson = {};
  try {
    claimsJson = await readJson<ClaimsJson>(
      path.join(projectDir, "drafts", "mr", "_claims.json"),
    );
  } catch {
    // _claims.json absent — all sections show "not available" boilerplate
  }

  const today = new Date().toISOString().slice(0, 10);
  const children: Paragraph[] = [];

  // Title — country name, bold, 28pt
  children.push(
    new Paragraph({
      children: [
        new TextRun({ text: manifest.country, bold: true, size: 56 }),
      ],
      spacing: { after: 80 },
    }),
  );

  // Subtitle — census name + reference year, 14pt
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `${manifest.census_name} · ${manifest.reference_year}`,
          size: 28,
        }),
      ],
      spacing: { after: 200 },
    }),
  );

  // "Metadata Review" heading
  children.push(
    new Paragraph({
      heading: HeadingLevel.HEADING_1,
      children: [new TextRun({ text: "Metadata Review", bold: true })],
    }),
  );

  // Compiled-by line — small grey text
  children.push(
    new Paragraph({
      children: [
        new TextRun({
          text: `Compiled by Ag Census MR TMR Compiler · ${today}`,
          color: GREY,
          size: 18,
        }),
      ],
      spacing: { after: 200 },
    }),
  );

  // Horizontal rule below header
  children.push(hRule());

  // Sections 1–15
  for (let n = 1; n <= 15; n++) {
    const title = MR_SECTION_TITLES[n] ?? `Section ${n}`;

    // Section heading — FAO green
    children.push(
      new Paragraph({
        heading: HeadingLevel.HEADING_1,
        children: [
          new TextRun({ text: `${n}. ${title}`, bold: true, color: FAO_GREEN }),
        ],
      }),
    );

    const sectionData = claimsJson[`section_${n}`];

    // Show "not available" only when the generator found no sourceable content
    // for this section (zero claims).  Approval status does not gate the export.
    if (!sectionData || sectionData.claims.length === 0) {
      children.push(
        new Paragraph({
          children: [
            new TextRun({
              text: "Information on this point was not available in the source documents provided.",
              italics: true,
              color: GREY,
            }),
          ],
          spacing: { after: 160 },
        }),
      );
    } else {
      for (const claim of sectionData.claims) {
        children.push(
          new Paragraph({
            children: [new TextRun({ text: claim.text })],
            spacing: { after: 80 },
          }),
        );
        // Source citations are internal references — omit them in the clean
        // (external distribution) version.  Draft mode keeps them for review.
        if (!clean && claim.sources.length > 0) {
          const sourceText = claim.sources.map((s) => s.page_id).join(", ");
          children.push(
            new Paragraph({
              children: [
                new TextRun({
                  text: `Source: ${sourceText}`,
                  color: GREY,
                  size: 18,
                }),
              ],
              spacing: { after: 120 },
            }),
          );
        }
      }
    }

    // Thin rule between sections (not after the last)
    if (n < 15) {
      children.push(hRule());
    }
  }

  // Footer with page numbers
  const footer = new Footer({
    children: [
      new Paragraph({
        alignment: AlignmentType.CENTER,
        children: [
          new TextRun({ children: [PageNumber.CURRENT] }),
          new TextRun({ text: " / " }),
          new TextRun({ children: [PageNumber.TOTAL_PAGES] }),
        ],
      }),
    ],
  });

  const doc = new Document({
    sections: [
      {
        properties: {},
        footers: { default: footer },
        children,
      },
    ],
  });

  const outputDir = path.join(projectDir, "exports");
  await mkdir(outputDir, { recursive: true });
  // Draft files get a -draft suffix; clean (final) files do not.
  const suffix   = clean ? "" : "-draft";
  const filename = `${manifest.country_iso3.toLowerCase()}-mr-${today}${suffix}.docx`;
  const outputPath = path.join(outputDir, filename);

  const buffer = await Packer.toBuffer(doc);
  await writeFile(outputPath, buffer);
  return outputPath;
}
