/**
 * MR (Metadata Review) section generator.
 *
 * Exports `generateSection(projectDir, sectionNumber, model)`.
 *
 * For each section the generator:
 *   1. Loads the MR system prompt from references/mr-prompt-v1.3.md.
 *   2. Loads the section-specific instruction from
 *      src/generators/mr-prompts/section-<NN>-<name>.md.
 *   3. Retrieves the most relevant evidence pages via evidence.ts.
 *   4. Calls generate() with the assembled prompt.
 *   5. Strips markdown fences and parses the JSON response.
 *   6. Verifies every cited page_id exists on disk; drops unverified citations.
 *   7. Writes verified claims to drafts/mr/_claims.json under section_<N>.
 *   8. Renders claims as Markdown prose to drafts/mr/current.md.
 *   9. Appends a generation_completed audit event.
 *
 * On JSON parse failure: writes a warning header + raw text to current.md,
 * sets parse_failed in the audit event, and returns — never throws.
 *
 * Constraints:
 *  - All paths use path.join() — no hardcoded separators.
 *  - All file I/O uses fs/promises — no sync calls.
 */

import { readFile, writeFile, access } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { generate } from "../providers/index";
import type { Model } from "../providers/types";
import { retrieveEvidence } from "./evidence";
import { readEvidence, appendAuditEvent } from "../project/io";
import type { AuditEvent, PageJson } from "../project/schema";

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const __dirname = path.dirname(fileURLToPath(import.meta.url));

/** Prompt version baked into every audit event and history file name. */
const PROMPT_VERSION = "v1.3";

/**
 * Path to the MR system prompt.
 * Resolved as: <src/generators/../../references/mr-prompt-v1.3.md>
 *              = <worktree-root>/references/mr-prompt-v1.3.md
 */
const MR_SYSTEM_PROMPT_PATH = path.resolve(
  __dirname,
  "..",
  "..",
  "references",
  "mr-prompt-v1.3.md",
);

/** Directory that contains per-section instruction files. */
const SECTION_PROMPTS_DIR = path.resolve(__dirname, "mr-prompts");

// ---------------------------------------------------------------------------
// Section metadata
// ---------------------------------------------------------------------------

/** Valid section numbers for an MR report. */
const MIN_SECTION = 1;
const MAX_SECTION = 15;

/** Evidence retrieval keywords per section number. */
const SECTION_KEYWORDS: Record<number, string[]> = {
  1: [
    "census", "history", "first", "year", "conducted", "previous", "round",
    "agricultural census", "livestock census", "population census", "sample census",
    "1960", "1952", "first census", "earliest", "history of",
  ],
  2: [
    "law", "legal", "decree", "regulation", "act", "statute", "ordinance",
    "institution", "ministry", "organisation", "authority", "lead", "staff",
    "enumerator", "supervisor", "hierarchy", "mandate", "confidentiality",
  ],
  3: [
    "reference date", "reference period", "reference day", "agricultural year",
    "stock", "flow", "calendar", "interview date", "crop year", "growing season",
  ],
  4: [
    "enumeration", "fieldwork", "data collection", "period", "start", "end",
    "phase", "schedule", "duration", "listing", "pilot",
  ],
  5: [
    "scope", "statistical unit", "holding", "agricultural holding", "definition",
    "crops", "livestock", "forestry", "aquaculture", "threshold", "household",
    "non-household", "parcel", "community", "inclusion", "minimum size",
  ],
  6: [
    "coverage", "geographic", "territory", "exclusion", "excluded", "area",
    "province", "district", "region", "threshold", "size", "cut-off",
    "sub-threshold", "national",
  ],
  7: [
    "methodology", "method", "modular", "classical", "register", "frame",
    "sample", "enumeration", "complete", "questionnaire", "interview", "CAPI",
    "paper", "digital", "design", "stratification", "cluster", "probability",
    "WCA 2020", "essential items", "thematic",
  ],
  8: [
    "technology", "device", "tablet", "smartphone", "mobile", "software",
    "application", "CAPI", "GPS", "digital", "platform", "transmission",
    "server", "monitoring", "dashboard", "ODK", "KoBoToolbox", "CSPro",
    "GIS", "mapping", "administrative register",
  ],
  9: [
    "processing", "validation", "editing", "imputation", "correction", "error",
    "cleaning", "consistency", "coding", "entry", "tabulation", "database",
    "range check", "logic check", "outlier",
  ],
  10: [
    "quality", "pilot", "pre-test", "training", "supervisor", "supervision",
    "monitoring", "back-check", "re-interview", "verification", "field check",
    "coverage check", "non-response", "response rate",
  ],
  11: [
    "archive", "database", "storage", "repository", "metadata", "microdata",
    "cartography", "digital", "access", "NADA", "DDI", "format",
    "dissemination platform", "website", "open data",
  ],
  12: [
    "reconciliation", "comparison", "discrepancy", "administrative register",
    "previous census", "agricultural survey", "consistency", "cross-check",
    "benchmark",
  ],
  13: [
    "publication", "dissemination", "release", "report", "preliminary", "final",
    "statistical table", "microdata", "anonymised", "access", "website",
    "open data", "portal", "volume", "bulletin", "press release",
  ],
  14: [
    "source", "document", "report", "publication", "reference", "bibliography",
    "authoring institution", "title", "year", "main report", "technical report",
    "questionnaire", "methodology report",
  ],
  15: [
    "contact", "address", "email", "telephone", "phone", "website",
    "institution", "office", "department", "division", "NSO",
    "national statistics", "postal",
  ],
};

/** Section instruction file names (matches filenames in mr-prompts/). */
const SECTION_FILENAMES: Record<number, string> = {
  1:  "section-01-historical-outline.md",
  2:  "section-02-legal-basis.md",
  3:  "section-03-reference-date.md",
  4:  "section-04-enumeration-period.md",
  5:  "section-05-scope-statistical-unit.md",
  6:  "section-06-census-coverage.md",
  7:  "section-07-methodology.md",
  8:  "section-08-technology.md",
  9:  "section-09-data-processing.md",
  10: "section-10-quality-assurance.md",
  11: "section-11-data-archiving.md",
  12: "section-12-data-reconciliation.md",
  13: "section-13-dissemination.md",
  14: "section-14-data-sources.md",
  15: "section-15-contact.md",
};

/** Human-readable section titles (used in the Markdown heading). */
const SECTION_TITLES: Record<number, string> = {
  1:  "Historical Outline",
  2:  "Legal Basis and Organisation",
  3:  "Reference Date and Period",
  4:  "Enumeration Period",
  5:  "Scope of the Census and Definition of the Statistical Unit",
  6:  "Census Coverage",
  7:  "Methodology",
  8:  "Use of Technology",
  9:  "Data Processing",
  10: "Quality Assurance",
  11: "Data and Metadata Archiving",
  12: "Data Reconciliation",
  13: "Dissemination of Census Results and Microdata",
  14: "Data Sources",
  15: "Contact",
};

/**
 * Per-section maxTokens budget.
 * Sections that consistently hit the 1024 limit (parse_failed in Session 10)
 * are raised to 1500. All other sections use 1024.
 */
const SECTION_MAX_TOKENS: Record<number, number> = {
  2:  1500,
  4:  1500,
  7:  1500,
  10: 1500,
  13: 1500,
};

/**
 * Per-section maxPages override for evidence retrieval.
 * Section 1 (Historical Outline) uses 30 pages to ensure the first-census-year
 * reference (which may appear on a less prominent page) is surfaced.
 * All other sections default to 20.
 */
const SECTION_MAX_PAGES: Record<number, number> = {
  1: 30,
};

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface GeneratedClaim {
  claim_id: string;
  text: string;
  sources: { page_id: string; passage_offset: [number, number] }[];
  deviation_flags: string[];
  human_edited: boolean;
  unverified_citation?: boolean;
}

interface ModelClaimsResponse {
  section: number;
  claims: GeneratedClaim[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function readJson<T>(filePath: string): Promise<T> {
  return JSON.parse(await readFile(filePath, "utf-8")) as T;
}

async function writeJson(filePath: string, data: unknown): Promise<void> {
  await writeFile(filePath, JSON.stringify(data, null, 2) + "\n", "utf-8");
}

/**
 * Robust JSON extraction.
 *
 * Step 1: strip markdown fences (handles ```json ... ``` and ``` ... ``` variants).
 * Step 2: strip thinking-model tag blocks that some Kimi K2.6 deployments emit
 *         inside the content field even when thinking is "disabled":
 *           <think>…</think>  <thinking>…</thinking>  <reasoning>…</reasoning>
 * Step 3: find the outermost { } pair, discarding any remaining preamble text.
 *
 * Returns the extracted JSON string, or null if no valid { } pair was found.
 */
function extractJson(text: string): string | null {
  // Step 1: strip markdown fences
  let s = text.replace(/```json\s*/gi, '').replace(/```\s*/g, '').trim();

  // Step 2: strip thinking/reasoning tag blocks
  // Use non-greedy match so nested content is handled correctly.
  s = s.replace(/<think>[\s\S]*?<\/think>/gi, '').trim();
  s = s.replace(/<thinking>[\s\S]*?<\/thinking>/gi, '').trim();
  s = s.replace(/<reasoning>[\s\S]*?<\/reasoning>/gi, '').trim();

  // Step 3: find the outermost { } pair
  const start = s.indexOf('{');
  const end = s.lastIndexOf('}');
  if (start === -1 || end === -1 || end <= start) return null;

  return s.slice(start, end + 1);
}

/**
 * Format evidence pages into the prompt block.
 * Each page is preceded by a header line for easy citation lookup.
 */
function formatEvidenceBlock(pages: PageJson[]): string {
  if (pages.length === 0) {
    return "(No matching evidence pages were found in the evidence store.)";
  }
  return pages
    .map((p) => `[Page ${p.page_id}, p.${p.page_number}]\n${p.text}`)
    .join("\n\n---\n\n");
}

/**
 * Build the user prompt sent to the model.
 */
function buildUserPrompt(
  sectionNumber: number,
  sectionInstruction: string,
  evidenceBlock: string,
): string {
  return `## Task

Generate Section ${sectionNumber} of an Agricultural Census Metadata Review, following the MR system prompt instructions above.

## Section-Specific Instructions

${sectionInstruction}

## Evidence Pages

The following pages have been retrieved from the indexed census documents. Base every claim exclusively on the content of these pages.

${evidenceBlock}

## Output Instructions

Return ONLY a valid JSON object. Do NOT wrap it in markdown code fences. Do NOT include any preamble, explanation, or commentary — just the JSON.

The JSON must follow this exact structure:

{
  "section": ${sectionNumber},
  "claims": [
    {
      "claim_id": "${sectionNumber}.1",
      "text": "The claim text as a single complete prose sentence.",
      "sources": [
        { "page_id": "<exact page_id from Evidence Pages above>", "passage_offset": [0, 0] }
      ],
      "deviation_flags": [],
      "human_edited": false
    }
  ]
}

Rules:
- Write between 3 and 7 distinct claims covering the full scope of the section.
- Every claim MUST cite at least one page_id. Use only page_ids that appear verbatim in the Evidence Pages headers above (e.g. "01-main-report-p014").
- passage_offset should always be [0, 0].
- claim_id values must follow the pattern "${sectionNumber}.1", "${sectionNumber}.2", etc.
- Each claim must be a single, complete, factual prose sentence that could stand alone.
- Do not include claims for which no supporting evidence page is available.`;
}

/**
 * Render the claims as Markdown prose for current.md.
 */
function renderMarkdown(
  sectionNumber: number,
  claims: GeneratedClaim[],
  pageNumMap: Map<string, number>,
): string {
  const title = SECTION_TITLES[sectionNumber] ?? `Section ${sectionNumber}`;
  const lines: string[] = [`# ${sectionNumber}. ${title}`, ""];

  for (const claim of claims) {
    let para = claim.text;

    if (claim.sources && claim.sources.length > 0) {
      const refs = claim.sources.map((s) => {
        const pageNum = pageNumMap.get(s.page_id);
        return pageNum !== undefined
          ? `${s.page_id}, p.${pageNum}`
          : s.page_id;
      });
      para += ` (Source: ${refs.join("; ")})`;
    }

    lines.push(para, "");
  }

  return lines.join("\n");
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generate one MR section and persist results to the project directory.
 *
 * @param projectDir    Absolute path to the country project directory.
 * @param sectionNumber The section number to generate (1–15).
 * @param model         The model to use for generation.
 */
export async function generateSection(
  projectDir: string,
  sectionNumber: number,
  model: Model,
): Promise<void> {
  // ── 0. Validate section number — return gracefully, never throw ──────────
  if (
    !Number.isInteger(sectionNumber) ||
    sectionNumber < MIN_SECTION ||
    sectionNumber > MAX_SECTION
  ) {
    const currentMdPath = path.join(projectDir, "drafts", "mr", "current.md");
    await writeFile(
      currentMdPath,
      `> ⚠️ **Invalid section number: ${sectionNumber}.** ` +
        `Valid values are ${MIN_SECTION}–${MAX_SECTION}.\n`,
      "utf-8",
    );
    return;
  }

  // ── 1. Load prompts ──────────────────────────────────────────────────────
  const systemPrompt = await readFile(MR_SYSTEM_PROMPT_PATH, "utf-8");

  const sectionFilename = SECTION_FILENAMES[sectionNumber]!;
  const sectionInstructionPath = path.join(
    SECTION_PROMPTS_DIR,
    sectionFilename,
  );
  const sectionInstruction = await readFile(sectionInstructionPath, "utf-8");

  // ── 2. Retrieve evidence ─────────────────────────────────────────────────
  const keywords = SECTION_KEYWORDS[sectionNumber] ?? [];
  const maxPages = SECTION_MAX_PAGES[sectionNumber] ?? 20;
  const pages = await retrieveEvidence(projectDir, keywords, maxPages, "mr");

  const evidenceBlock = formatEvidenceBlock(pages);
  const userPrompt = buildUserPrompt(
    sectionNumber,
    sectionInstruction,
    evidenceBlock,
  );

  // ── 3. Call the model ────────────────────────────────────────────────────
  const maxTokens = SECTION_MAX_TOKENS[sectionNumber] ?? 1024;
  const wallStart = Date.now();
  const result = await generate({
    systemPrompt,
    userPrompt,
    model,
    maxTokens,
  });
  const wallTimeMs = Date.now() - wallStart;
  const wasTruncated = result.finishReason === 'length';

  // ── 4. Parse the response ────────────────────────────────────────────────
  // Use extractJson to tolerate preamble text or partial thinking content
  // that some models (notably Kimi K2.6) emit before the JSON object.
  const extracted = extractJson(result.text);
  let parsed: ModelClaimsResponse | null = null;
  let parseFailed = false;

  try {
    if (!extracted) throw new Error("No JSON object found in response");
    parsed = JSON.parse(extracted) as ModelClaimsResponse;
    if (!Array.isArray(parsed?.claims)) {
      throw new Error("Response JSON missing 'claims' array");
    }
  } catch {
    parseFailed = true;
  }

  // ── 5. Write outputs ─────────────────────────────────────────────────────
  const claimsJsonPath = path.join(projectDir, "drafts", "mr", "_claims.json");
  const currentMdPath = path.join(projectDir, "drafts", "mr", "current.md");

  if (parseFailed || !parsed) {
    // Graceful fallback: write raw text with a warning header
    const truncationNote = wasTruncated
      ? ` Output was **truncated at max_tokens** — raise SECTION_MAX_TOKENS[${sectionNumber}].`
      : '';
    const warning =
      `> ⚠️ **JSON parse failed for Section ${sectionNumber}.**${truncationNote} ` +
      `Raw model output is shown below. Human review required.\n\n`;
    await writeFile(currentMdPath, warning + result.text, "utf-8");
  } else {
    // Citation verification: drop sources whose page files do not exist on disk
    const pagesDir = path.join(projectDir, "evidence", "pages");
    const claims = parsed.claims;

    for (const claim of claims) {
      const verifiedSources: typeof claim.sources = [];
      let hadInvalid = false;

      for (const source of claim.sources ?? []) {
        const pageFile = path.join(pagesDir, `${source.page_id}.json`);
        try {
          await access(pageFile);
          verifiedSources.push(source);
        } catch {
          hadInvalid = true; // page does not exist — drop the citation
        }
      }

      claim.sources = verifiedSources;
      if (hadInvalid) claim.unverified_citation = true;
    }

    // Split: cited claims go into _claims.json; uncited prose (e.g. "not
    // available" boilerplate) is rendered in current.md but NOT stored as
    // structured claims, since _claims.json must be purely evidence-backed.
    const citedClaims = claims.filter((c) => c.sources.length > 0);

    // Write to _claims.json, merging with any existing sections
    let claimsJson: Record<string, unknown> = {};
    try {
      claimsJson = await readJson<Record<string, unknown>>(claimsJsonPath);
    } catch {
      // File doesn't exist yet — start fresh
    }
    claimsJson[`section_${sectionNumber}`] = {
      claims: citedClaims,
      ...(wasTruncated && { truncated_warning: true }),
    };
    await writeJson(claimsJsonPath, claimsJson);

    // Render Markdown for current.md — includes ALL claims (cited + uncited)
    // so the narrative is complete even when some elements are undocumented.
    const pageNumMap = new Map(pages.map((p) => [p.page_id, p.page_number]));
    // Also load from evidence index in case citations used pages not in our top-N
    try {
      const evidenceIndex = await readEvidence(projectDir);
      for (const summary of evidenceIndex.pages) {
        if (!pageNumMap.has(summary.page_id)) {
          pageNumMap.set(summary.page_id, summary.page_number);
        }
      }
    } catch {
      // Evidence index unreadable — use only page numbers from retrieved pages
    }

    const md = renderMarkdown(sectionNumber, claims, pageNumMap);
    const truncationMdWarning = wasTruncated
      ? '> ⚠️ **Warning: model output was truncated (max_tokens reached). Claims may be incomplete.**\n\n'
      : '';
    await writeFile(currentMdPath, truncationMdWarning + md, "utf-8");
  }

  // ── 6. Append audit event ────────────────────────────────────────────────
  const event = {
    type: "generation_completed" as const,
    timestamp: new Date().toISOString(),
    target: "mr" as const,
    section_or_table: `section_${sectionNumber}`,
    prompt_version: PROMPT_VERSION,
    model: result.model,
    provider: result.provider,
    input_tokens: result.inputTokens,
    output_tokens: result.outputTokens,
    cost_usd: result.costUsd,
    wall_time_ms: wallTimeMs,
    ...(parseFailed && { parse_failed: true }),
    ...(wasTruncated && { truncated: true }),
  };
  await appendAuditEvent(projectDir, event as unknown as AuditEvent);
}
