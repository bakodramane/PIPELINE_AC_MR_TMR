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


## Session 10 — E2E checkpoint (Nepal + Pakistan)

**Files created:**
- `scripts/run-nepal.ts` — full E2E runner (15 MR + 23 TMR, deepseek-v4-flash)
- `scripts/run-pakistan.ts` — same for Pakistan
- `vitest.scripts.config.ts` — separate Vitest config for scripts/ (include: scripts/run-*.ts)
- `docs/nepal-run-summary.json` — actual run results
- `docs/pakistan-run-summary.json` — actual run results
- `docs/v1-week4-checkpoint.md` — full checkpoint document

**Run command:**
```
node "C:\Users\Dramane\Desktop\PIPELINE\node_modules\vitest\vitest.mjs" ^
  run --root "C:\Users\Dramane\Desktop\PIPELINE" ^
  --config vitest.scripts.config.ts --reporter verbose ^
  --testNamePattern "Nepal"
```
(The `include: tests/**/*.test.ts` in vitest.config.ts blocks scripts/ —
use vitest.scripts.config.ts instead.)


## Session 10 notes

NEPAL RESULTS (deepseek-v4-flash, 5.4 min, $0.17):
- MR: 14/15 ok, 1 parse_failed (§2 Legal Basis — hit 1024-token limit)
- TMR: 13/23 ok, 8/23 empty, 2 parse_failed (ST3 parcels, ST17 irrigation source)
- TMR cells: 107 populated / 247 missing
- Best TMR: ST9 holder age (41/48 cells), ST2 tenure (12/12)
- Empty TMR: ST8 holder sex, ST10 household size, ST12 livestock system,
  ST15–16 irrigation method/use, ST18–20 machinery/inputs — absent from Nepal NSCA

PAKISTAN RESULTS (deepseek-v4-flash, 6.9 min, $0.25):
- MR: 13/15 ok, 1 empty (§9 Data Processing), 1 parse_failed (§10 Quality Assurance)
- TMR: 0/23 ok, 21/23 empty, 2 parse_failed (ST3, ST17)
- TMR cells: 0 populated — COMPLETE FAILURE
- Root cause: Pakistan main-report.pdf (110 pages, 0 tables) is a narrative document;
  the statistical tables volume has not been ingested. Need to find and ingest it.

PARSE FAILURE PATTERN: Sections §2, §10 and sub-tables ST3, ST17 consistently hit the
1024-token max_tokens limit. Fix in Session 11: raise limits for these to 1500.

SECTION 1 PAKISTAN QUALITY GAP: Still cites 1972 as first census; correct is 1960.
Fix in Session 13: add keywords '1960', 'first census' to SECTION_KEYWORDS[1].

COST: $0.42 for both countries combined (well under the $2–5 estimate).
DeepSeek V4-Flash promo pricing ($0.435/$0.87 per M) expires 2026-05-31.

VITEST SCRIPTS CONFIG: vitest.scripts.config.ts uses testTimeout: 7_200_000 (2 hours).
The scripts themselves set the same timeout internally. Background run via
run_in_background: true works — the process is NOT killed at the Bash 10-min limit.


## Session 11 — Token budget fixes + Pakistan TMR data source

**Files created/modified:**
- `src/generators/mr.ts` — token budget + keyword fixes:
  - `SECTION_MAX_TOKENS` extended: added `2: 1500, 4: 1500, 10: 1500` (those three
    consistently parse_failed at 1024 in Session 10)
  - `SECTION_MAX_PAGES` new map: `{ 1: 30 }` — section 1 now retrieves 30 pages
    instead of 20 to surface Pakistan's 1960 first-census-year reference
  - `SECTION_KEYWORDS[1]` extended: added `"1960"`, `"1952"`, `"first census"`,
    `"earliest"`, `"history of"`
  - Evidence retrieval now passes `SECTION_MAX_PAGES[sectionNumber] ?? 20` as third arg
  - Truncation detection: `wasTruncated = result.finishReason === 'length'`; spreads
    `truncated: true` into the audit event, `truncated_warning: true` into `_claims.json`,
    and prepends a ⚠️ warning header to `current.md` when the parse succeeds but output
    was cut; extends the parse-failure warning to mention the truncation
- `src/generators/tmr.ts` — token budget + truncation detection:
  - `SUB_TABLE_MAX_TOKENS` new map: `{ 3: 1500, 17: 1500 }` (those two parse_failed
    at 1024 in Session 10)
  - `generate()` now uses `SUB_TABLE_MAX_TOKENS[subTableNumber] ?? MAX_TOKENS`
  - `anyTruncated` boolean; set when any row call returns `finishReason === 'length'`
  - `truncated: true` spread into both the parse-failure path and the success path of
    `_cells.json`, and into the audit event
- `references/pakistan-2024/sources/02-statistical-tables.pdf` — copied from
  `references/pakistan-2024/EXAMPLE OF TABLE OF Main results  PAKISTAN.pdf` (double space)
- `scripts/verify-pakistan-tmr.ts` — Vitest verification script:
  - Ingests `02-statistical-tables.pdf` into a fresh Pakistan project
  - Runs `generateSubTable` for sub-tables 1 and 2 with `deepseek-v4-flash`
  - Prints all populated cells to console
  - Asserts `Total_Holdings` is a number and equals 11,701,584 (±1000)
- `vitest.scripts.config.ts` — added `"scripts/verify-*.ts"` to include array;
  raised `hookTimeout` to 1,800,000 ms (30 min) to accommodate ingest + generation

---

## Session 11 notes

PAKISTAN TMR VERIFY RESULTS (9 s, 2/2 tests passed):
- 02-statistical-tables.pdf: 6 pages, 0 tables indexed (162 ms ingest)
- ST1 Total_Holdings: 11,701,584 — exact match, delta = 0
- ST1 Total_Area: 23,998,161 ha — found
- ST2 Owner: 10,386,504 holdings | Owner-cum-tenant: 547,977 | Tenants: 767,103
- Legal-status breakdown rows (Civil/Juridical) correctly return ".." — not in
  Pakistan census terminology, consistent with Nepal behaviour

TOKEN BUDGET CHANGES:
- MR sections 2, 4, 10 raised to 1500. Combined with existing 7 and 13,
  five sections now use 1500 tokens. All others remain at 1024.
- TMR sub-tables 3 and 17 raised to 1500. All others remain at 1024.
- Truncation is now surfaced in: audit event (truncated: true),
  _claims.json (truncated_warning: true), current.md (⚠️ header),
  _cells.json (truncated: true). Never silently discarded.

KEYWORD COVERAGE (Section 1):
- Added historical census years (1960, 1952) and phrasing variants to
  SECTION_KEYWORDS[1]. maxPages raised to 30 for this section only.
  Full verification deferred to Session 12 (re-run Pakistan §1).

BEFOREALL IN VITEST: beforeAll() does NOT accept a context argument.
Only test() callbacks receive a context. Use `if (!shouldRun) return;`
inside beforeAll; use `ctx.skip()` only inside test() callbacks.

NEXT SESSION: Re-run full Pakistan pipeline (15 MR + 23 TMR) against
both main-report.pdf AND 02-statistical-tables.pdf to measure improvement.
Expected: ST1/ST2 fully populated, ST3/ST17 parse failures resolved,
Pakistan §1 first-census-year corrected to 1960.


## Session 12 — Tauri frontend (two screens)

**Files created/modified:**
- `src-tauri/Cargo.toml` — added `tauri-plugin-fs = "2"` to `[dependencies]`
- `src-tauri/src/lib.rs` — complete rewrite:
  - Registers `tauri_plugin_fs::init()` for sandboxed FS access from the webview
  - Exposes `generate_mr_sections(project_dir, model)` Tauri command (currently returns
    informative error pointing to CLI scripts; real wiring deferred to Session 14)
- `src-tauri/capabilities/default.json` — added FS read permissions:
  ```json
  { "identifier": "fs:allow-read-text-file", "allow": [{ "path": "$HOME/**" }] }
  { "identifier": "fs:allow-read-dir",       "allow": [{ "path": "$HOME/**" }] }
  { "identifier": "fs:allow-exists",         "allow": [{ "path": "$HOME/**" }] }
  ```
- `package.json` — added `@tauri-apps/plugin-fs: ^2.5.1` (npm install)
- `src/types/ui.ts` — shared UI types: `ProjectInfo`, `SectionInfo`, `SectionStatus`,
  `ToastMessage`, `MR_SECTION_TITLES`, `MR_SECTIONS_TOTAL = 15`, `TMR_SUBTABLES_TOTAL = 23`
- `src/hooks/useProjects.ts` — React hook that reads project base dir, lists country
  subdirectories, loads `manifest.json` + MR/TMR progress counts per project; persists
  base dir in `localStorage`; default path `~/Documents/AgCensus`
- `src/screens/ProjectList.tsx` — Screen 1: project grid with status bars, folder picker,
  refresh, placeholder "New project" and "Import bundle" buttons
- `src/screens/MrReview.tsx` — Screen 2: 15 collapsible MR section cards showing claims
  from `_claims.json`, source badges, deviation flags, truncation warnings; "Generate all
  sections" button with spinner; "Edit" and "Approve" per-section action buttons
- `src/App.tsx` — complete rewrite: two-screen state machine (list / mr-review), global
  toast notification system (auto-dismiss 3.5 s info/success, 7 s error/warning)

**Tauri build status:**
- `npm run tauri:dev` succeeded: Vite started on port 1420, Rust compiled cleanly in ~60 s
  (`tauri-plugin-fs v2.5.1` and `tauri-plugin v2.6.2` downloaded and compiled)
- `agcensus-compiler.exe` launched without errors

---

## Session 12 notes

TWO-SCREEN STATE MACHINE: No router. `type Screen = {id:'list'} | {id:'mr-review', projectDir, projectName}`.
Navigation via `setScreen()`. `window.scrollTo(0,0)` on each screen change.

GENERATE BUTTON: Real generation requires spawning Node.js from Rust (sidecar pattern).
Decision: Rust command returns informative error pointing to CLI scripts; shown as warning
toast. UI still shows correct spinner/disable behaviour while invoke is pending.
Wire up actual generation in Session 14.

TYPESCRIPT STRICT MODE FIX (useProjects.ts TMR status):
`_cells.json` sub-table entries mix `Cell` objects with `validation_flags`, `parse_failed`,
`truncated` keys that don't conform to the Cell schema. Cast through
`subTable as Record<string, unknown>` then `(v as {value?: unknown}).value` to check for
numeric values without triggering TS2352 overlap errors.

NODE.JS / WEBVIEW ISOLATION: `src/project/io.ts` uses `node:fs/promises` and CANNOT be
imported in frontend code. Always import types from `schema.ts` (safe); use
`@tauri-apps/plugin-fs` for any FS access inside the webview.

MR STATUS IN PROJECT CARDS: Counts `section_N` keys with `claims.length > 0` from
`_claims.json`. A section with `claims.length === 0` counts as empty (not ok).

TMR STATUS IN PROJECT CARDS: Counts `sub_table_N` keys with at least one cell having
`{value: number}` (not `".."` or `null`). Non-cell keys in the sub-table entry are
safely skipped by the object-walk cast pattern above.

NEXT SESSION: Re-run full Pakistan pipeline with updated token budgets and keyword
coverage. Verify Pakistan §1 now correctly cites 1960. Session 14 will wire the
"Generate all sections" button to a real sidecar invocation.


## Session 13 — TMR cell review screen + Project overview screen

**Files created:**
- `src/screens/TmrReview.tsx` — Screen 3: 23 WCA 2020 sub-table cards with expandable cell
  grids. Per-card status badge (populated/partial/empty/parse_failed/not_generated), cell
  count, validation flag count. Expanded view shows a row × column table with numeric
  values, missing-value codes (grey italic with tooltip), derived flag ("d" superscript),
  unverified-source flag ("?" superscript + orange left border), and validation failure
  rows below the table. "Generate sub-table" + "Generate all sub-tables" buttons (both
  call `generate_tmr_subtable` Rust command which returns Ok("queued")).
- `src/screens/ProjectOverview.tsx` — Hub screen between project list and detail views.
  Four metric cards (Sources indexed, MR sections, TMR cells filled, Open issues).
  Two side-by-side generator panels (MR draft, TMR draft) with status summary and
  "Open review" / "Generate all" buttons. Navigation tab row (MR draft, TMR draft,
  Sources, Issues, Audit log — last three are placeholder toasts for now).

**Files modified:**
- `src/types/ui.ts` — added `SubTableStatus`, `TmrCellDisplay`, `ValidationFlagDisplay`,
  `SubTableInfo`; added `tmrCellsOk: number` and `tmrCellsTotal: number` to `ProjectInfo`;
  added `TMR_CELLS_TOTAL = 388` constant
- `src/hooks/useProjects.ts` — updated `computeTmrStatus` to also count individual
  populated cells (not just sub-tables); returns `cellsOk` and `cellsTotal`; removed
  `CellsJson` import (using `Record<string, unknown>` cast instead)
- `src/screens/MrReview.tsx` — added `onSwitchToTmr: () => void` prop; added MR/TMR tab
  bar below the top header bar for switching between MR sections and TMR sub-tables
- `src/screens/ProjectList.tsx` — changed `onOpenProject(dir, name)` to
  `onOpenProject(project: ProjectInfo)` so the full project data flows to App.tsx
- `src/App.tsx` — complete rewrite: four-screen state machine
  `list → project-overview → mr-review / tmr-review`; all screens carry `project:
  ProjectInfo` so back-navigation can reconstruct project-overview without a re-fetch
- `src-tauri/src/lib.rs` — added `generate_tmr_subtable(project_dir, sub_table_number,
  model)` command; sub_table_number=0 means "all sub-tables"; returns `Ok("queued")`
  (real wiring deferred to Session 14)

**Build status:**
- `npx tsc --noEmit` → no output (zero errors)
- `npm run tauri:dev` → Rust compiled in 8.46 s (crates already cached), app launched

---

## Session 13 notes

CELL KEY CONVENTION: The cell key format in `_cells.json` is `toCellKey(row, col)`:
  `{rowLabel_spaces→underscores}_{colLabel_unit-suffix-stripped_spaces→underscores}`
  e.g. row="Total", col="Area (ha)" → "Total_Area"
       row="Civil persons", col="Holdings" → "Civil_persons_Holdings"
This function is replicated in TmrReview.tsx for the grid lookup. Keep both in sync.

NON-CELL KEYS IN _cells.json: Each sub-table entry in `_cells.json` contains mixed keys:
  - Cell entries: objects with `value`, `unit`, `sources`, etc.
  - `validation_flags`: ValidationFlag[] array
  - `parse_failed`: boolean (true on complete generation failure)
  - `truncated`: boolean (true when finishReason === 'length')
  - `raw_response`: string (on total parse failure)
The frontend filters these out by checking for the `value` property on each entry.
Constant `NON_CELL_KEYS = Set(["validation_flags", "parse_failed", "truncated", "raw_response"])`.

TMR_CELLS_TOTAL = 388: Derived from summing rows × columns for all 23 WCA sub-tables.
Hardcoded in `src/types/ui.ts` to avoid importing wca-2020.json in the hook.
Breakdown in comments in ui.ts. Update if sub-tables are ever added to wca-2020.json.

WCA JSON IMPORT: `wcaData from "../concepts/wca-2020.json"` works in the frontend because
`tsconfig.json` has `resolveJsonModule: true`. The type is cast locally in TmrReview.tsx
to `Record<string, WcaSubTableSpec>` to allow dynamic access by sub-table number.

FOUR-SCREEN NAVIGATION: Screen type carries `project: ProjectInfo` in all non-list states.
This means back-navigation to project-overview doesn't need a re-fetch. The project data
shown in the overview is the snapshot loaded when the user clicked the project card — it
won't auto-update if files change on disk. Use the "Refresh" button in the project list
to reload project data.

GENERATE TMR SUBTABLE: sub_table_number=0 means "all" in the Rust command. This avoids
needing a separate `generate_all_tmr` command. Session 14 will replace the placeholder
with real sidecar invocation.

---

## Session 14 — Wire generator buttons to real Node.js generators

**Files created/modified:**
- `src-tauri/scripts/generate.ts` — new CLI wrapper; run via `node tsx/dist/cli.mjs generate.ts --project ... --type mr|tmr --all|--section <n>|--subtable <n> [--model]`
- `src-tauri/Cargo.toml` — added `tauri-plugin-shell = "2"`
- `src-tauri/src/lib.rs` — real shell invocation + stdout line parsing + Tauri event emission
- `src/screens/MrReview.tsx` — `listen("generation-progress")` + per-section reload + progress bar
- `src/screens/TmrReview.tsx` — same pattern for TMR; per-subtable spinner via `generatingOne` state
- `src/screens/ProjectOverview.tsx` — real `invoke` calls on "Generate all" buttons + spinners
- `package.json` / `package-lock.json` — added `tsx` as devDependency (TypeScript runner for Node)

**Architecture (shell-based generator invocation):**

```
Tauri UI  →  invoke("generate_mr_sections", { projectDir, model })
              ↓
           Rust: app.shell().command("node").args([tsx_cli, generate.ts, ...]).spawn()
              ↓
           Node child process running generate.ts via tsx
              ↓  stdout (line-buffered)
           DONE:N  / ERROR:N:msg / STATUS:msg
              ↓
           Rust: app.emit("generation-progress", { type, number, status, message })
              ↓
           Frontend: listen("generation-progress") → reloadSection(n) / reloadSubTable(n)
```

**Key decisions:**
- tsx (`node node_modules/tsx/dist/cli.mjs`) used instead of `node --experimental-strip-types`
  because Node 22 strip-types does NOT resolve extensionless TypeScript imports (e.g., `import
  { x } from "../module"` won't find `../module.ts`). tsx registers a module loader that handles
  this correctly.
- Generator paths use `CARGO_MANIFEST_DIR.parent()` (= PIPELINE root) — avoids `..` segments
  in paths, which would require canonicalize and risk UNC prefix issues on Windows.
- Rust-side `app.shell().command(...)` does NOT require capability permissions. Only frontend JS
  shell API needs `shell:allow-spawn`. Since generation is purely Rust-side, no capabilities
  changed.
- Progress events use `#[serde(rename = "type")]` on the Rust struct so the JSON field is
  "type" (not "gen_type"), matching the frontend `GenerationProgressPayload` interface.
- `listen(...)` is awaited BEFORE `invoke(...)` so no events are missed during the initial
  generation startup.

**v1 limitation — dev mode only:**
The shell-based invocation (`env!("CARGO_MANIFEST_DIR")` + `node node_modules/tsx/...`) only
works in development. In a production Tauri bundle, `CARGO_MANIFEST_DIR` points to the build
machine's source tree (not the user's machine) and `node_modules` is not bundled with the app.

For v1 production builds, one of the following must be implemented before shipping:
  a) Bundle the generators as a Tauri sidecar (pre-compiled Node bundle via `esbuild --bundle`)
  b) Require Node.js on the user's PATH and bundle `generate.ts` as a resource
  c) Port the generators to Rust/WASM

This is tracked as a known limitation. For FAO internal use where statisticians always have
Node installed and run from the source checkout, the current approach is sufficient.

NEXT SESSION (14): Wire `generate_mr_sections` and `generate_tmr_subtable` to actual
Node.js generation via Tauri sidecar or shell_execute. Consider running generation in
a background thread with progress events streamed back via Tauri events.