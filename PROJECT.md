# AgCensus Compiler — Project Notes

This file records architectural decisions, session findings, and forward-looking notes
for future sessions. See `DESIGN.md` for the authoritative specification.

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
