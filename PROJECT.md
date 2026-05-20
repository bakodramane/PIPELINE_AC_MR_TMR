# AgCensus Compiler — Project Notes

This file records architectural decisions, session findings, and forward-looking notes
for future sessions. See `DESIGN.md` for the authoritative specification.

## Provider notes (discovered Session 2)

DeepSeek V4-Flash: must send thinking: { type: 'disabled' } on every
request. Default is thinking mode; content is empty without this flag.

Kimi K2.6: temperature must be exactly 1.0. API returns 400 for any
other value. Both thinking and non-thinking modes enforce this.

DeepSeek V4-Pro promo pricing ($0.435/$0.87 per M tokens) expires
2026-05-31. Update pricing.json after that date.

---

## Session 3 — MR Section 1 generator (Nepal)

**Files created/modified:**
- `src/providers/deepseek.ts` — `thinking: { type: "disabled" }` required for `deepseek-v4-flash`
- `src/providers/kimi.ts` — temperature must always be `1.0` for Kimi K2.6 (API rejects other values)
- `src/generators/evidence.ts` — two-pass keyword retrieval (index score + full-text re-score)
- `src/generators/mr.ts` — MR section 1 generator
- `references/mr-prompt-v1.3.md` — canonical MR system prompt (converted from PDF)
- `src/generators/mr-prompts/section-01-historical-outline.md` — section instruction
- `tests/mr-section1.test.ts` — Nepal E2E test

---

## Session 3 notes

validate.ts returns typed ValidationIssue[] with severity error | warning.
Run validateProject(dir) after any generation to catch schema drift early.

EvidenceIndex entries carry keywords[] for relevance matching —
added by agent, not in DESIGN.md §4 explicitly. Kept: it is the
right hook for Session 5's evidence retrieval step.


## Session 4 — MR Sections 2–15 + Pakistan validation

**Files created/modified:**
- `src/generators/mr.ts` — extended to support all 15 sections
  - Full `SECTION_KEYWORDS`, `SECTION_FILENAMES`, `SECTION_TITLES` maps for sections 1–15
  - `SECTION_MAX_TOKENS`: sections 7 (Methodology) and 13 (Dissemination) use 1500 tokens; all others 1024
  - Out-of-range section guard: writes warning to `current.md` and returns — never throws
  - **Critical fix**: `_claims.json` stores only `citedClaims` (sources.length > 0); `current.md` renders all claims including "not available" boilerplate. This separates evidence-backed structured data from narrative prose.
- `src/generators/mr-prompts/section-02-legal-basis.md` through `section-15-contact.md` — 14 new section instruction files
- `tests/mr-section1-pakistan.test.ts` — Pakistan E2E test (same 5-assertion contract as Nepal)
- `vitest.config.ts` — added `fileParallelism: false` to prevent two concurrent DeepSeek API calls from racing each other (caused parse failures under parallel execution)

**Key principle established:**
`_claims.json` is purely evidence-backed. "Information not available" acknowledgments belong in `current.md` only, never in `_claims.json` with empty `sources[]`.

---

## Session 4 notes

pdf-parse v2 API differs significantly from v1 — see src/ingest/pdf.ts
for actual usage. getScreenshot() returns PNG buffers directly,
used for the Tesseract OCR fallback path.

Table extraction is heuristic (whitespace/tab-separated columns,
3+ consecutive consistent rows). Works on the TMR-style tables
in Nepal and Pakistan reports. May need tuning for scanned PDFs
from other countries.

Re-ingest deduplicates on evidence ID — safe to re-run the pipeline
after adding or correcting a source document.

DEFERRED VERIFICATION: ingest tests must be run against the real
Nepal and Pakistan PDFs before Session 5 starts.


## Session 5 — TMR Sub-table 1 generator

**Files created:**
- `src/concepts/wca-2020.json` — WCA 2020 concept registry (sub-table 1 only; expand in session 8+)
- `src/generators/tmr.ts` — TMR sub-table generator
- `tests/tmr-subtable1.test.ts` — Nepal E2E test for sub-table 1

**Design decisions:**

### Source citation: tables AND page text
The Nepal census does not use WCA 2020 "legal status" terminology ("civil persons",
"juridical persons"). The data in the Nepal census for sub-table 1 exists in two forms:
- **Total_Holdings** (4,130,789): stated as prose in page text (p.26)
- **Total_Area** (2,218,410 ha): stated as prose in page text (p.27)
- **Breakdown rows**: not applicable to Nepal (different categorization); correctly `".."`

The generator therefore supports `source_table_id` holding either:
- A real `table_id` (e.g., `"01-main-report-t003"`) from `evidence/tables/`
- A `page_id` (e.g., `"01-main-report-p0026"`) from `evidence/pages/`

Verification checks both directories. This reflects the reality that census data
sometimes appears only in prose text, not in structured tables.

### Evidence table extraction limitation
The heuristic table extractor (`src/ingest/tables.ts`) works by detecting multi-space
/ tab column separators. For the Nepal PDF, only 3 tables were extracted — all from
the table of contents (which uses dot leaders that trigger the multi-space detector).
The actual data tables in the Nepal census use a layout the heuristic misses.
**Future improvement**: the `extractTables` function should be extended to handle
PDF tables with single-space or no-space column alignment, or a PDF library with
native table extraction should be integrated.

### `unverified_source` semantics
A cell with `value: ".."` AND empty `source_table_id` is a **legitimate** "not available"
response — the model searched and found nothing. This must NOT be flagged as
`unverified_source: true`. Only flag when a non-empty source_id was provided but
the file does not exist on disk.

### Unit conversion
`1 acre = 0.4047 ha` is applied in code, never by the model. If the model reports
`unit: "acres"`, the generator converts and sets `derived: true`, `conversion: "acres to ha: ..."`.

### Validation
After populating all cells, the `sum_to_total` rule runs for EACH column independently:
- `Civil_persons + Group_of_civil_persons + Juridical_persons = Total` (within ±1)
- Failures are recorded as `validation_flags` on the sub-table object
- Empty `validation_flags: []` means the rule passed or could not be evaluated (some values `.."`)

### Temperature
`temperature: 0` is set for all TMR generation calls. Data extraction is deterministic
by nature — the correct value is fixed in the source document. Temperature=0 eliminates
model non-determinism and makes test results reproducible.

---

## Multi-row generation note (from Session Sequence document)

Sub-table 1 has only 4 rows — a single model call is appropriate here.

**For sub-tables with 10+ rows** (e.g., sub-table 3 — Livestock by type,
sub-table 7 — Crops by type, etc.), the generator MUST populate **one row per model call**.
Sending all rows in a single prompt causes the model to lose track of which row it is
populating, leading to transposed values and hallucinations.

The multi-row generation pattern (one API call per row) must be implemented in
Session 8+ when those sub-tables are built. Do not implement it here.

---

## Evidence retrieval keywords (sub-table 1)

```
["holdings", "legal status", "civil", "juridical", "total holdings", "area"]
```

Note: "legal status", "civil", "juridical" do not appear in the Nepal census text.
They DO appear in Pakistan and other censuses that follow WCA 2020 terminology.
The keywords are designed to cover all countries, not just Nepal.

---

## Test infrastructure

- `vitest.config.ts`: `fileParallelism: false` — critical for tests that hit external APIs
  (prevents concurrent API calls that cause rate-limit errors or malformed responses)
- `hookTimeout`: 30,000 ms (default); `beforeAll` timeout: 180,000 ms (set per test)
- `testTimeout`: 120,000 ms (for individual assertions; the heavy work is in `beforeAll`)


## Session 5 notes

MR generator is live. Section 1 verified against Nepal gold standard —
all claims factually correct, zero unverified citations.

SINGLE-PAGE SOURCING: Nepal section 1 drew all claims from p.18.
Correct for this section. Watch for over-concentration on one page
in later sections — if all claims cite the same page, evidence
retrieval keywords may need broadening.

EVIDENCE SCORER: Two-pass approach in evidence.ts — index-only first,
then text re-score on top 2×maxPages candidates. Keep this pattern
for all subsequent retrieveEvidence calls.

MR PROMPT: references/mr-prompt-v1.3.md was converted from PDF by
the agent. Verify the conversion is faithful before relying on it
as the canonical prompt — open both and compare sections 1–3.

AUDIT TRAIL: generation_completed events now writing to audit log
with real token counts and cost. Check audit/ after each test run.


## Session 6 notes

PAKISTAN SECTION 1 QUALITY GAP: Generator cited 1972 as first
Pakistan census; correct answer is 1960. Root cause: evidence
retrieval did not surface the page containing the 1960 reference.
Fix options: (1) broaden historical-outline keywords to include
'1960', '1972', 'first census'; (2) increase maxPages for section 1
from 20 to 30. Address in Session 10 end-to-end review.

UNCITED CLAIMS: Claims with no evidence citations are split out of
_claims.json and rendered only in current.md with a warning.
_claims.json must contain only evidence-backed claims. This is
enforced in mr.ts citedClaims filter.

PARALLEL API CALLS: fileParallelism: false in vitest.config.ts
prevents race conditions when multiple test files make live API
calls. Keep this for all future API-dependent test files.

SECTIONS 2-15: Instruction files written, routing implemented,
per-section maxTokens applied (1500 for §7 and §13, 1024 others).
End-to-end validation deferred to Session 10.


## Session 7 notes

TMR GENERATOR ARCHITECTURE:
- Census data typically lives in page prose text, not structured
  tables. PDF table heuristic only extracted TOC entries for Nepal.
  Source verification checks both evidence/tables/ and evidence/pages/.
  This is permanent behaviour — do not revert.

- temperature: 0 on all TMR generation calls for determinism.
  The MR generator can use default temperature; TMR must not.

- Empty source_table_id + ".." value = legitimate not-available.
  Only flag unverified_source when a non-empty ID was given but
  does not exist on disk.

- Evidence pages sent first in prompt (primary source), extracted
  tables sent second (supplementary). This order matters — do not
  swap.

LEGAL STATUS TERMINOLOGY: Nepal NSCA does not use WCA 2020 legal
status categories (civil persons, juridical persons). Breakdown
rows correctly return ".." — not a bug, a real definitional
deviation. This pattern will recur across many countries.

VALIDATION: sum_to_total passes vacuously when all component rows
are "..". This is correct behaviour. A future improvement could
distinguish "vacuous pass" from "verified pass" in the flag output.

ROW ALIGNMENT WARNING (from Session Sequence):
Never populate more than one row per model call in sub-tables with
10+ rows. Sub-table 1 has 4 rows — single call fine here.
Sub-tables 13 (livestock, 18 rows) and 22-23 (crops, many rows)
must use one-row-per-call approach. Implement from Session 8 onward.

---

## Session 8 — TMR sub-tables 2–11

**Files created/modified:**
- `src/concepts/wca-2020.json` — extended with sub-tables 2–11
- `src/generators/tmr.ts` — extended to handle sub-tables 2–11:
  - `SUBTABLE_KEYWORDS` (now exported) covers 1–11
  - `MULTI_ROW_SUBTABLES = {4, 5, 7, 9}` — one API call per row
  - `HOUSEHOLD_SECTOR_SUBTABLES = {6, 7, 8, 9, 10}` — household sector note in prompt
  - `ValidationRule.tolerance` field added (sub-table 4 uses tolerance 100)
  - `verifySource()` extracted as a helper
  - Token counts aggregated across all row calls into one audit event
- `tests/tmr-routing.test.ts` — offline smoke test (3 assertions, no API calls)

**Key design decisions:**

### Multi-row generation (sub-tables 4, 5, 7, 9)
`MULTI_ROW_SUBTABLES` contains the sub-table numbers that require one API call
per row. The generator loops over `spec.rows`, calls `generate()` once per row,
and merges results into a single `_cells.json` entry. Token counts are aggregated
into one `generation_completed` audit event.

### Household sector note (sub-tables 6–10)
When `HOUSEHOLD_SECTOR_SUBTABLES.has(subTableNumber)`, the user prompt includes:
> "Universe note: This sub-table covers the **household sector only**."

### Validation tolerance
`ValidationRule` now has an optional `tolerance` field (default: 1). Sub-table 4
(size classes) uses `tolerance: 100` because rounding across many rows can
accumulate to tens rather than ±1.

### Duplicate row labels (sub-tables 7, 9, 11)
The user-specified row lists for sub-tables 7, 9, and 11 use qualified row names
(e.g. "Male – engaged", "Under 25 – Male") to avoid duplicate cell keys. The
original WCA 2020 spec uses ambiguous labels (e.g. bare "Male" repeated);
we resolved this by appending the parent context to each sub-row label.

### Smoke test pattern
`tests/tmr-routing.test.ts` imports `SUBTABLE_KEYWORDS` (exported from tmr.ts)
and reads `wca-2020.json` directly — zero API calls. All TMR structural
assertions should live here; E2E tests with API calls are per-country tests.


## Session 9 notes

MULTI_ROW_SUBTABLES = {4, 5, 7, 9, 13, 22, 23} — exported from tmr.ts.
Sub-table 13: 22 rows, one API call per row, three sum_to_total rules
(Large ruminants, Small ruminants, Poultry). Row-alignment defence active.

CROP TOTAL TOLERANCE: Sub-tables 22 and 23 use tolerance 1000 on
sum_to_total validation. Reason: enumerated crop sub-rows do not always
sum to published total because some crop types are aggregated differently
by the NSO. This is intentional — do not reduce without testing against
Nepal and Pakistan data.

WORKTREE GUARD: confirmed working in sessions 8 and 9. Agent detects
worktree path, stops, and writes to absolute paths. Keep the guard line
at the top of every session prompt.