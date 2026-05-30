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

---

## Session 15 — BOM-free project creation + §2 token audit

**Goals:**
1. Audit §2 empty-section root cause — confirm sidecar does not cap `maxTokens` below what `SECTION_MAX_TOKENS` specifies.
2. Replace PowerShell-based project creation (which writes UTF-8 WITH BOM via `WriteAllText`) with a Rust Tauri command that writes raw bytes — no BOM.

**Goal 1 — §2 token audit (no code change required):**

Investigation confirmed the generation chain is correct end-to-end:
- `generate.ts` calls `generateSection(args.project, n, args.model)` — exactly 3 params, no `maxTokens` argument.
- `generateSection` signature is `(projectDir, sectionNumber, model)` — no 4th param exists.
- Inside `mr.ts`, line 400: `const maxTokens = SECTION_MAX_TOKENS[sectionNumber] ?? 1024;`
- `SECTION_MAX_TOKENS = { 2: 1500, 4: 1500, 7: 1500, 10: 1500, 13: 1500 }` — §2 already at 1500 tokens.

**Conclusion:** The sidecar never overrides the token budget; the architecture is already correct. If §2 is empty it is a retrieval or LLM issue, not a token cap.

**Goal 2 — BOM-free project creation:**

Root cause: PowerShell `[System.IO.File]::WriteAllText` defaults to UTF-8 WITH BOM (bytes 239 187 191). JSON parsers (and the app's `useProjects` hook) reject BOM-prefixed files.

Solution — new `create_project` Tauri command in `src-tauri/src/lib.rs`:

```rust
#[tauri::command]
fn create_project(project_dir: String, manifest: String) -> Result<String, String>
```

- Accepts the project directory path and the manifest JSON string from the frontend.
- Creates subdirectories: `evidence/pages`, `evidence/tables`, `drafts/mr`, `drafts/tmr`, `sources`, `audit`.
- Writes skeleton files using `std::fs::write(path, bytes)` — raw bytes, NO BOM:
  - `manifest.json` ← manifest JSON string as UTF-8 bytes
  - `evidence/_evidence.json` ← `{"pages":[],"tables":[]}`
  - `drafts/mr/_claims.json` ← `{}`
  - `drafts/tmr/_cells.json` ← `{}`
  - `sources/_index.json` ← `[]`
- Returns `Ok(project_dir)` on success; `Err(message)` on any I/O failure.
- Registered in `tauri::generate_handler![generate_mr_sections, generate_tmr_subtable, create_project]`.
- No Tauri capability changes needed — Rust backend has unrestricted filesystem access.

**Frontend — `src/screens/ProjectList.tsx`:**

- Added `invoke` import from `@tauri-apps/api/core`.
- Added `joinProjectPath(base, name)` helper — detects `\` vs `/` separator from base path.
- Added `METHODOLOGY_OPTIONS` constant: sample-based / classical / register-based / complete enumeration / modular / integrated.
- Added `NewProjectFormData` interface and `NewProjectForm` component — inline card form with 6 fields: country, ISO3, census name, reference year, methodology type (select), statistical unit (pre-filled "agricultural holding").
- Added `showNewProjectForm` + `creating` state in `ProjectList`.
- Added `handleCreateProject(data)` async handler — constructs `<Country>-<Year>` directory name, builds manifest JSON, invokes `create_project`, shows success toast, calls `refresh()`.
- `+ New project` button now toggles the form open/closed (becomes `✕ Cancel` when open) instead of showing a placeholder toast.
- Form appears inline above the project grid inside `<main>` — no modal.

**BOM verification (run in PowerShell after creating a project):**
```powershell
$bytes = [System.IO.File]::ReadAllBytes("C:\Users\Dramane\Documents\AgCensus\Pakistan-2024\manifest.json")
Write-Host "First 3 bytes: $($bytes[0]) $($bytes[1]) $($bytes[2])"
# BOM-free: 123 10 32  ('{', newline, space)
# BOM present: 239 187 191  (← bad, old PowerShell behaviour)
```

**Files changed:**
- `src-tauri/src/lib.rs` — added `create_project` sync command + registered in handler
- `src/screens/ProjectList.tsx` — inline new-project form wired to `create_project` invoke

NEXT SESSION (16): Add PDF/document ingestion to source indexing — allow drag-dropping or file-picking PDFs into a project's `sources/` directory and extracting text into `evidence/pages/`.

---

## Session 16 — T8 token fix + TMR/MR export (XLSX + Markdown)

**Goals accomplished:**
1. Fix sub_table_8 truncation (one-line token budget change)
2. TMR Excel export via new `exportTmr` generator + `export_project` Tauri command
3. MR Markdown export via new `exportMr` generator + same Tauri command

**Goal 1 — ST8 token budget:**
Added `8: 1500` to `SUB_TABLE_MAX_TOKENS` in `src/generators/tmr.ts`.  The Pakistan
audit log showed `truncated: true` + `parse_failed: true` on sub_table_8 (Sex of
agricultural holder, 7 rows × 2 cols = 14 cells) — identical root cause to ST3 and
ST17 fixed in Session 11.  Map now reads `{ 3: 1500, 8: 1500, 17: 1500 }`.

**Goal 2 — TMR XLSX export:**

`src/generators/export-tmr.ts`:
- Reads `drafts/tmr/_cells.json` and `src/concepts/wca-2020.json`
- Uses SheetJS (`xlsx` 0.18.5, added to `dependencies` in `package.json`)
- Builds one sheet "TMR_Results" with merged title + universe rows, grey column-header row, one data row per WCA row label
- Cell value rules: numbers as numbers, missing-value codes as strings, ungenerated sub-tables → single merged row "— not yet generated"
- Basic formatting via SheetJS `cell.s` property: bold title/header cells, grey fill (`#E8E8E8`) on column headers, right-aligned numeric cells
- Output path: `exports/<iso3>-tmr-<YYYY-MM-DD>.xlsx`

**Goal 3 — MR Markdown export:**

`src/generators/export-mr.ts`:
- Reads `drafts/mr/_claims.json` + `manifest.json`
- Imports `MR_SECTION_TITLES` from `src/types/ui` (safe in Node: no browser APIs)
- Produces structured Markdown: H1 country/census title, H2 "Metadata Review", H3 per section, claims with `> Source: <page_id>, p.<N>` references
- Empty sections → WCA boilerplate: `*Information on this point was not available...*`
- Output path: `exports/<iso3>-mr-<YYYY-MM-DD>.md`

**CLI wrapper `src-tauri/scripts/export.mjs`:**
- Node ESM script, invoked via tsx: `node <tsx-cli.mjs> export.mjs --project ... --type tmr|mr`
- Dynamic imports `export-tmr.ts` / `export-mr.ts` via tsx module loader (handles `.ts` extension)
- Stdout protocol: `DONE:<output_path>` on success, `ERROR:<message>` on failure; exits 0

**Tauri command `export_project`:**
Added to `src-tauri/src/lib.rs`:
- `async fn export_project(app, project_dir: String, export_type: String) -> Result<String, String>`
- Spawns `node <tsx-cli.mjs> export.mjs --project ... --type ...` via tauri-plugin-shell
- Reads stdout for `DONE:<path>` → returns path; `ERROR:<msg>` → returns Err
- Registered in `generate_handler![..., export_project]`

**Frontend export buttons:**
- `TmrReview.tsx`: "↓ Export XLSX" button added to the left of "↻ Generate all sub-tables" in header bar. Outline style (`border-white/40 text-white/80`) distinguishes it from the generate button. Disabled while generating.
- `MrReview.tsx`: "↓ Export MD" button added to the left of "↻ Generate all sections" — same pattern.
- Both: spinner while running, `onToast` success with filename only (not full path), `onToast` error on failure.

**Files changed:**
- `src/generators/tmr.ts` — `SUB_TABLE_MAX_TOKENS`: added `8: 1500`
- `src/generators/export-tmr.ts` — NEW: TMR → XLSX export
- `src/generators/export-mr.ts` — NEW: MR → Markdown export
- `src-tauri/scripts/export.mjs` — NEW: export CLI wrapper (invoked by Tauri via tsx)
- `src-tauri/src/lib.rs` — added `export_project` async command + registered in handler
- `src/screens/TmrReview.tsx` — "↓ Export XLSX" button + `exporting` state + `handleExport`
- `src/screens/MrReview.tsx` — "↓ Export MD" button + `exporting` state + `handleExport`
- `package.json` / `package-lock.json` — `xlsx: ^0.18.5` added to dependencies

**BOM note:** Export files are written by Rust (manifest read) then by Node `fs/promises.writeFile`
(UTF-8 string) — no BOM. The `xlsx` package's `XLSX.write(..., {type:"buffer"})` returns a raw
`Buffer` written via `fs.writeFile`; no BOM is possible.

NEXT SESSION (17): PDF/document ingestion — drag-drop or file-pick PDFs into `sources/`, index
pages into `evidence/pages/` so generators can retrieve evidence for new country projects.

---

## Session 17 — Inline MR editing, section approval, audit log viewer

**Goals accomplished:**
1. Inline claim editing for MR sections (Goal 1)
2. Section approval button with approved badge (Goal 2)
3. Audit log viewer screen (Goal 3)

**Goal 1 — Inline claim editing:**

New Tauri command `save_mr_section(project_dir, section_number, claims_json)` in `lib.rs`:
- Reads `_claims.json`, replaces `section_<n>` key with new section data
- Sets `approved: false` on save (editing resets approval — guard against stale approval)
- Writes back with `serde_json::to_string_pretty` (no BOM)
- Returns `Ok(())` (sync command, uses `std::fs`)

`SectionCard` in `MrReview.tsx` now has internal edit state:
- `editing`, `editClaims`, `saving`, `approving` state
- Clicking "Edit claims": clones current claims into `editClaims`, enters edit mode
- Edit mode: each claim shows `AutoResizeTextarea` (self-expanding) + non-editable source citation labels + "✕ Delete" button
- "Add claim" button: appends blank claim with `human_edited: true`
- "Save": marks all claims `human_edited: true`, invokes `save_mr_section`, awaits `reloadSection`, exits edit mode, shows success toast
- "Cancel": discards `editClaims`, exits edit mode without saving
- Header toggle is disabled while editing (header not clickable; "Editing" indicator shown)

**Goal 2 — Approve button:**

New Tauri command `approve_mr_section(project_dir, section_number)` in `lib.rs`:
- Reads `_claims.json`, sets `section_<n>.approved = true`, writes back
- Returns `Err` if section key not found (must generate first)

`SectionInfo` in `ui.ts` gained `approved: boolean` field.

`buildSections` and `reloadSection` in `MrReview.tsx` now read `sectionData.approved === true`.

`SectionCard` approve button behavior:
- Active (green): "✓ Approve" → invokes `approve_mr_section`, reloads section, shows success toast
- While approving: spinner + "Approving…"
- After approval: greyed-out emerald-700, "✓ Approved", disabled
- After saving edits: `approved` resets to `false` (Rust sets it) → button becomes active again

`ApprovedBadge` component: emerald "✓ approved" badge shown in section card header alongside the status badge when `section.approved === true`.

**Goal 3 — Audit log viewer:**

New file `src/screens/AuditLog.tsx`:
- Loads all `*.jsonl` files from `audit/` via `readDir` + `readTextFile` (Tauri fs plugin)
- Parses each newline-delimited JSON event line
- Sorts newest-first by default with toggle to oldest-first
- Event type colour coding: generation=blue, edit=yellow, approval/certified=emerald, export=purple, ingest/project=grey, flag=orange
- Per-event detail rows:
  - generation_completed: target (MR §n / TMR Tn), model, in/out tokens, cost USD, wall time
  - generation_started: target, model, "starting…"
  - section_edited/cell_edited: section/table key, claim/cell key, old→new value
  - export: format + filename (last path component only)
  - source_added/evidence_indexed/project_created: source details
  - certified_gold_standard/flag_raised/flag_resolved: certifier/location + details
- "↓ Download full log" button: invokes new `open_path` Rust command that calls `app.shell().open(path, None)` to open the most-recent JSONL in system default text editor

New Tauri command `open_path(path: String)` in `lib.rs`:
- Uses `app.shell().open(&path, None::<String>)` (sync)
- Returns `Ok(())` or `Err(message)` — no capability changes needed (Rust backend)

`ProjectOverview.tsx`: added `onOpenAuditLog: () => void` prop; "Audit log" NavTab now calls it instead of showing a toast.

`App.tsx`: added `audit-log` Screen variant; renders `<AuditLog>` with back navigation to `project-overview`.

**Files changed:**
- `src-tauri/src/lib.rs` — added `save_mr_section`, `approve_mr_section`, `open_path` commands + registered
- `src/types/ui.ts` — `SectionInfo.approved: boolean` field added
- `src/screens/MrReview.tsx` — complete rewrite with inline editing + approve
- `src/screens/AuditLog.tsx` — NEW: audit log viewer screen
- `src/screens/ProjectOverview.tsx` — `onOpenAuditLog` prop + Audit log tab wired
- `src/App.tsx` — `audit-log` screen variant added

**TypeScript:** `npx tsc --noEmit` → zero errors.

NEXT SESSION (18): Multi-provider support + Settings screen — see Session 18 notes below.

---

## Session 18 — Multi-provider support, model selector, settings screen

**Goals accomplished:**
1. Extended provider abstraction to 10 models across 5 providers (Goal 1)
2. Settings screen with API key management and default model selection (Goal 2)
3. Model selector dropdown on MR and TMR review screens (Goal 3)
4. API keys from store passed via --api-key arg to generator sidecar (Goal 4)

**Goal 1 — Provider abstraction (10 models, 5 providers):**

`src/providers/types.ts`:
- `Provider` extended: added `"google" | "openai" | "anthropic"`
- `Model` extended: added Tier 1 (`gemini-2.0-flash`, `gpt-4o-mini`), Tier 2 (`gemini-2.5-flash`), Tier 3 (`gpt-4o`, `gemini-2.5-pro`, `claude-opus-4-7`)
- New `ModelInfo` interface: model, provider, displayName, tier, tierLabel, inputCostPerM, outputCostPerM, contextWindow, supportsThinking, bestFor

`src/providers/pricing.json`: Extended with 6 new models (gemini-2.0-flash $0.10/$0.40, gemini-2.5-flash $0.15/$0.60, gemini-2.5-pro $1.25/$10.00, gpt-4o-mini $0.15/$0.60, gpt-4o $2.50/$10.00, claude-opus-4-7 $3.00/$15.00)

New provider modules:
- `src/providers/google.ts` — Google Gemini via OpenAI-compatible endpoint (`https://generativelanguage.googleapis.com/v1beta/openai/`); env var `GOOGLE_API_KEY`
- `src/providers/openai.ts` — standard OpenAI API (`https://api.openai.com/v1`); env var `OPENAI_API_KEY`
- `src/providers/anthropic.ts` — `@anthropic-ai/sdk` (NOT OpenAI compat layer); streaming via `client.messages.stream()` + `.on("text")` + `.finalMessage()`; env var `ANTHROPIC_API_KEY`

`src/providers/model-registry.ts` (NEW): Exports `MODEL_REGISTRY` (flat array of 10 `ModelInfo`), `MODELS_BY_TIER` (grouped by tier), `DEFAULT_MR_MODEL = "deepseek-v4-flash"`, `DEFAULT_TMR_MODEL = "deepseek-v4-flash"`, `getModelInfo(model)`.

`src/providers/index.ts`: Updated `generate()` routing via `getProvider()` (prefix-based: deepseek-/kimi-/gemini-/gpt-/claude-). Added `testApiConnection(provider, apiKey)` export — makes a minimal test call to cheapest model per provider for Settings screen API key verification.

**Goal 2 — Settings screen:**

`src/screens/Settings.tsx` (NEW):
- API Keys section: one row per provider (DeepSeek, Moonshot/Kimi, Google, OpenAI, Anthropic) with password input, show/hide toggle, Test button (`testApiConnection`), Save button (`invoke("save_api_key")`), status indicator (Saved ✓ / Not configured / Connection OK with latency / Error)
- Default Models section: two `<select>` droppers (MR / TMR) grouped by tier; persisted to `localStorage`
- Project Folder section: display current base dir + inline edit box
- About section: version info

New Rust commands in `src-tauri/src/lib.rs`:
```rust
fn save_api_key(app, provider: String, key: String) -> Result<(), String>
fn get_api_key(app, provider: String) -> Result<Option<String>, String>
```
Both backed by `tauri-plugin-store` (`app.store("api_keys.json")`). Added `.plugin(tauri_plugin_store::Builder::new().build())` to Tauri builder.

`src-tauri/Cargo.toml`: added `tauri-plugin-store = "2"`.

`src/App.tsx`: Added `{ id: "settings" }` Screen variant. Fixed gear icon (`⚙`) in bottom-left corner visible on all non-settings screens; stores `prevScreen` to restore on Settings close.

**Goal 3 — Model selector in review screens:**

`src/screens/MrReview.tsx`:
- Added `selectedModel` state (localStorage `"agcensus_mr_model"`, default `DEFAULT_MR_MODEL`)
- Dark green model selector bar between header and progress bar: `<select>` with `<optgroup>` per tier; cost estimate (est. 30K in + 6K out tokens → ~$X.XXX for 15 sections)
- `generate_mr_sections` now uses `selectedModel` instead of hardcoded `"deepseek-v4-flash"`

`src/screens/TmrReview.tsx`: same pattern with `"agcensus_tmr_model"` and TMR cost estimate (23 × 1500 in + 600 out tokens).

**Goal 4 — API key injection to generator sidecar:**

`src-tauri/src/lib.rs` (`generate_mr_sections`, `generate_tmr_subtable`):
- Calls `provider_for_model(&model)` (prefix-based lookup)
- Calls `read_api_key_from_store(&app, provider)` — reads from tauri-plugin-store
- Passes `--provider <name>` always; `--api-key <key>` only when a key is found in store
- Falls back to env vars / .env file if no key in store (existing behaviour)

`src-tauri/scripts/generate.ts`:
- `ParsedArgs` extended: `provider?: string`, `apiKey?: string`
- `parseArgs` handles `--provider` and `--api-key` flags
- After `loadDotEnv()`: if `args.apiKey && args.provider`, sets the env var (`DEEPSEEK_API_KEY` etc.) only if not already present — env var in .env file takes precedence in dev

**npm:**
- `@anthropic-ai/sdk` added (`npm install @anthropic-ai/sdk --save`)

**TypeScript:** `npx tsc --noEmit` → zero errors.

**Files changed this session:**
- `package.json` / `package-lock.json` — added `@anthropic-ai/sdk`
- `src-tauri/Cargo.toml` — added `tauri-plugin-store = "2"`
- `src-tauri/src/lib.rs` — added `save_api_key`, `get_api_key`, `provider_for_model`, `read_api_key_from_store`; updated `generate_mr_sections` and `generate_tmr_subtable` to pass `--provider`/`--api-key`; registered store plugin
- `src-tauri/scripts/generate.ts` — extended `ParsedArgs`, `parseArgs`, `PROVIDER_ENV_VARS`, API key injection in `main()`; extended `Model` type to 10 models
- `src/providers/types.ts` — extended `Model` (10 models), `Provider` (5 providers); added `ModelInfo`
- `src/providers/pricing.json` — added 6 new model entries
- `src/providers/google.ts` — NEW
- `src/providers/openai.ts` — NEW
- `src/providers/anthropic.ts` — NEW
- `src/providers/model-registry.ts` — NEW
- `src/providers/index.ts` — routing + `testApiConnection` export
- `src/screens/Settings.tsx` — NEW
- `src/screens/MrReview.tsx` — model selector + imports
- `src/screens/TmrReview.tsx` — model selector + imports
- `src/App.tsx` — settings screen + gear icon overlay

NEXT SESSION (19): PDF/document ingestion — drag-drop or file-pick PDFs into `sources/`,
index pages into `evidence/pages/` so generators can retrieve evidence for new country projects.

---

## Session 19 — Sources tab UI + ingest sidecar + pilot launcher/docs

**Goals accomplished:**
1. Real Sources tab embedded in `ProjectOverview` (list + drag-drop + file picker + index flow)
2. `src-tauri/scripts/ingest.mjs` ingest CLI wrapper
3. `copy_source_file` + `ingest_source` Tauri commands
4. `launch-agcensus.bat` double-clickable launcher
5. `PILOT-SETUP.md` + `PILOT-FEEDBACK.md` plain-English pilot docs

**Frontend — `src/screens/ProjectOverview.tsx`:**
- "Sources" NavTab is now a toggle that renders an embedded `SourcesTab` panel
  (no new screen / no App.tsx change). Clicking other tabs still navigates as before.
- `SourcesTab`:
  - Reads `sources/_index.json` via `@tauri-apps/plugin-fs` `readTextFile`; renders
    one `SourceRow` per entry (filename, doc ID, page count, language, retrieved date,
    "Indexed ✓" green badge when `page_count > 0` else "⚠ Low confidence" amber).
  - Drop zone: listens for the Tauri window event `tauri://drag-drop` (payload.paths)
    AND supports click-to-browse via `@tauri-apps/plugin-dialog` `open({ filters: pdf })`.
    HTML `<input type=file>` deliberately NOT used (can't see real FS paths in Tauri).
  - Inline form pre-fills Document ID from filename: `NN-<sanitized-stem>` where NN =
    `(sources.length + 1)` zero-padded. Language dropdown EN/FR/ES/AR/PT/Other (default en).
  - "Add and index": (1) `invoke("copy_source_file", {srcPath, projectDir, docId, filename})`
    → dest path; (2) sets progress "Indexing pages… 30–60 s"; (3) `invoke("ingest_source", …)`;
    listens for `ingest-progress` events filtered by `doc_id`; on done reloads `_index.json`
    and toasts "Indexed successfully · N pages"; on error red toast.
  - Duplicate doc ID → first click shows an inline "already exists, click again to replace"
    amber confirm; second click proceeds (ingest.mjs upserts, so replace is real).

**`src-tauri/scripts/ingest.mjs`:** mirrors `export.mjs` structure. Parses
`--project/--doc-id/--file/--language`; resolves `PIPELINE_ROOT` via `fileURLToPath`
+ `path.resolve(__dirname, "..", "..")`; dynamic-imports `ingestPdf` from
`src/ingest/pipeline.ts` (tsx resolves the `.ts` extension); after ingest it counts
this doc's pages from `evidence/_evidence.json`, computes SHA-256 of the copied file,
and **upserts** both `sources/_index.json` (SourceIndexEntry) and
`manifest.json.source_documents` (removes any prior entry with the same id first).
Prints `DONE:<pageCount>` or `ERROR:<msg>`; always exits 0.

**`src-tauri/src/lib.rs`:**
- `copy_source_file(src_path, project_dir, doc_id, filename) -> Result<String>` — sync,
  `std::fs::create_dir_all(sources/)` + `std::fs::copy` to `sources/<doc_id>-<filename>`,
  returns dest path. Mirrors `create_project` style.
- `ingest_source(app, project_dir, doc_id, file_path, language) -> Result<()>` — async,
  spawns `node <tsx-cli> ingest.mjs …` via `app.shell()`, line-buffers stdout, emits
  `ingest-progress` `{ doc_id, status, page_count, message }` on DONE:/ERROR:. Mirrors
  `generate_mr_sections` exactly. New `IngestProgressPayload` struct (Serialize+Clone).
- Registered both in `generate_handler!`; added `.plugin(tauri_plugin_dialog::init())`.

**Config:**
- `src-tauri/Cargo.toml`: `tauri-plugin-dialog = "2"`.
- `src-tauri/capabilities/default.json`: added `"dialog:allow-open"`.
- `package.json`: `@tauri-apps/plugin-dialog ^2.7.1` (npm install).

**Pilot deliverables (project root):** `launch-agcensus.bat`, `PILOT-SETUP.md`,
`PILOT-FEEDBACK.md` — verbatim per spec.

---

## Session 19 notes

VERIFICATION DONE: `npx tsc --noEmit` → zero errors. Vite dev server (the one
`tauri dev` uses for the frontend) serves HTTP 200 and transforms
`ProjectOverview.tsx` + `@tauri-apps/plugin-dialog` cleanly.

ENVIRONMENT BLOCKER (NEW MACHINE): This checkout is on `C:\Users\bakod\…`, a
DIFFERENT machine from the Session 1–18 `C:\Users\Dramane\…` logs. It has **no
native C/C++ build toolchain** — no MSVC `link.exe`/`cl.exe`, no Windows SDK
import libs (`kernel32.lib`), no clang/lld-link. `target/debug` has never produced
an `.exe`. Therefore `cargo check` / `npm run tauri:dev` cannot LINK here — this is
an environment gap, NOT a code defect. Fix: install Visual Studio Build Tools 2022
with the "Desktop development with C++" workload + Windows SDK, then restart the
terminal. `rust-lld.exe` ships with rustup but still needs the SDK import libs.

PRE-EXISTING BUILD ISSUE (not from this session): `npm run build` (production Vite)
fails because `@anthropic-ai/sdk` (added Session 18) imports `node:crypto`
(`randomUUID`) which Rollup can't externalize for the browser bundle. `tauri:dev`
uses the Vite DEV server (esbuild) and is unaffected. If a production bundle is ever
needed, the anthropic SDK import will need isolating behind a Node-only entry or a
Vite `define`/alias for `node:crypto`.

DRAG-DROP IN TAURI: Tauri v2 webviews do NOT fire HTML5 `drop` events with real file
paths by default — the OS drop is captured by the window. Use the
`tauri://drag-drop` window event (payload `{ paths: string[] }`) instead. The CSS
`onDragOver`/`onDragLeave` handlers are kept only for the hover highlight.

NEXT SESSION (20): Issues queue screen (the last placeholder NavTab), and wire
`source_added`/`evidence_indexed` audit events through to the Audit log viewer so
newly-ingested sources show up in the chronological log.

---

## Session 20 — Pilot fixes: Excel ingest, multi-file, non-English TMR, MD export

Four pilot-reported issues fixed.

**Fix 1 — Excel ingestion:**
- NEW `src/ingest/excel.ts` — `parseExcel(filePath, sourceDocId, language)` using
  SheetJS (`xlsx`). One TableJson + one PageJson per sheet.
  - table_id / page_id: `<docId>-sheet-<1-based-index>-<slug(sheetName)>`
  - page_number = sheet index (1-based); title = sheet name; columns = first
    non-empty row; rows = remaining rows `{label, values:(string|number)[]}`
    (cast `as unknown as TableRow` since schema TableRow.values is `(number|null)[]`);
    units = {}; extraction_confidence = 0.95.
  - PageJson.text = sheet name + all cell values joined; headings = [sheetName];
    tables_on_page = [tableId]; extraction_confidence = 0.95.
- `src/ingest/pipeline.ts` — NEW exported `ingestExcel(...)` mirroring ingestPdf's
  persistence (writePage/writeTable/evidence-index merge/audit). `ingestPdf` unchanged.
- `src-tauri/scripts/ingest.mjs` — detects ext: `.xlsx`/`.xls` → ingestExcel,
  else ingestPdf. DONE count is sheet count for Excel (= page count, since one
  PageJson per sheet). NOTE: this file has mojibake em-dashes (`â€”`) from an
  external edit — avoid matching comment lines containing them when editing.
- VERIFIED end-to-end: ran ingest.mjs on `references/nepal-2021/sources/NPL_RES_ENG_2022.xlsx`
  → `DONE:117`, 117 table + 117 page files, _index.json upserted with page_count
  + sha256, table JSON well-formed (page_number=sheet index, conf 0.95, units {}).

**Fix 2 — Multiple file selection (`src/screens/ProjectOverview.tsx`):**
- `open({ multiple: true, filters:[{name:'Census documents', extensions:['pdf','xlsx','xls']}] })`.
- Drag-drop (`tauri://drag-drop`) now collects ALL accepted-extension paths.
- SourcesTab reworked from single `pending` file to a `queue: QueuedFile[]` +
  `queueIndex`. The Document-ID/language form is shown one file at a time
  ("File X of N: name — confirm ID and language, then continue"). Each click of
  "Add and continue" / "Add and index" ingests that file, then advances; per-file
  errors are toasted but do NOT abort the batch. `batchResults` ref tallies ok/fail
  across the batch (survives re-renders). End-of-batch summary toast:
  single → "Indexed successfully · N pages"; multi all-ok → "Indexed N documents
  successfully"; multi with failures → "Indexed X of N — Y failed (see details)".
- Auto-ID prefix uses `postCount` (fresh sources length after each ingest) so
  batched files get sequential NN- prefixes without collision.
- Module consts `ACCEPTED_EXTENSIONS` / `hasAcceptedExtension` / `QueuedFile`.

**Fix 3 — Non-English TMR retrieval (`src/generators/evidence.ts`):**
- `retrieveEvidence(projectDir, keywords, maxPages=20, mode:'mr'|'tmr'='mr')`.
- mode 'tmr': adds numeric-density score = `(text.match(/\d+/g)||[]).length * 0.1`
  to each page's combined score → number-heavy pages (census tables, any script)
  rank higher regardless of English keyword match.
- Empty-result fallback: if `result.length === 0` after scoring/filtering, return
  the first maxPages index pages sorted by page_number, each spread with
  `fallback: true` (no length filter applied, so it never returns empty when pages exist).
- `PageJson` gained optional `extraction_confidence?: number` and `fallback?: boolean`
  (schema.ts). Both optional → no breakage to PDF pages (confidence undefined).
- `tmr.ts`: passes `mode:'tmr'`; computes `nonEnglishHint = pages.some(p =>
  (p.extraction_confidence ?? 1) < 0.8 || p.fallback === true)`; when true,
  buildUserPrompt appends the non-English positional-reading instruction.
- `mr.ts`: passes `mode:'mr'` explicitly.
- VERIFIED: against the 117-page Nepal Excel project, garbage keywords in TMR mode
  still surface the 5 most number-dense pages (density working); a 2-short-page
  project with no keyword match returns both pages flagged `fallback:true` sorted
  by page number (Change 2 + flag working).

**Fix 4 — MD export (`src/generators/export-mr.ts`):**
- INVESTIGATED: the described bug (writeFile inside the section loop) was NOT
  present — the file already builds the whole document in memory (single `writeFile`
  at the end) and iterates `for n in 1..15` explicitly with the WCA "not available"
  boilerplate for empty sections. No code change needed.
- VERIFIED: ran export.mjs on a scratch project with only §1 and §5 populated →
  output .md has all 15 `### N.` headings in order, 2 populated, 13 placeholders.

**Verification:** `npx tsc --noEmit` → zero errors. No Rust changes this session.
Live GUI tests (add Excel via Sources tab, 2-PDF multi-select, Pakistan MR export,
Mongolia TMR) NOT run here: this machine has no AgCensus projects (Pakistan/Mongolia
were on the pilot machine) and no AgCensus data dir yet. All four fixes validated via
direct pipeline/script execution (ingest.mjs, export.mjs) + retrieveEvidence runtime
tests + Vite transform of ProjectOverview.tsx instead.

NOTE for live Mongolia test: the numeric-density change (Fix 3 Change 1) is what
should make number-bearing sub-tables populate even with Cyrillic surrounding text;
the empty-fallback (Change 2) only triggers when zero pages pass the ≥100-char filter.


## Session 21 — Pilot fixes: rename, source delete, Kimi fix, DOCX export

Four fixes from pilot feedback.

**Fix 1 — App renamed to "Ag Census MR TMR Compiler":**
- `src-tauri/tauri.conf.json`: `productName` and window `title`
- `src/screens/ProjectList.tsx`: header `<div>` text
- `launch-agcensus.bat`: `title` line and `echo` banner
- `PILOT-SETUP.md`: all references
- `src/screens/Settings.tsx`: About section

**Fix 2 — Delete indexed source documents:**
- `src/screens/ProjectOverview.tsx`: `SourceRow` gets a hover-reveal SVG trash
  button using Tailwind `group`/`group-hover:opacity-100`; `SourcesTab` gains
  `deleteTarget` + `deleting` state and a `handleDeleteConfirmed()` function that
  invokes `delete_source`; full-screen confirmation overlay with Cancel + Delete.
- `src-tauri/src/lib.rs`: `delete_source(project_dir, doc_id)` — removes
  `evidence/pages/<id>-*.json`, `evidence/tables/<id>-*.json`, the physical file
  from `sources/`, and prunes `_index.json`, `_evidence.json`, `manifest.json`.
  Registered in `generate_handler!`.

**Fix 3 — Kimi K2.6 API:**
- `src/providers/kimi.ts`: removed `temperature: 1.0` default; replaced
  `chat_template_kwargs: { thinking: bool }` with conditional
  `extra_body: { thinking: { type: "disabled" } }` for non-thinking mode.
- `src/providers/types.ts`: `"kimi-k2.6-non-thinking"` → `"kimi-k2.6"`.
- `src/providers/pricing.json`: key renamed to `"kimi-k2.6"`.
- `src/providers/model-registry.ts`: model string + displayName updated.
- `src/providers/index.ts`: `TEST_MODELS.kimi` → `"kimi-k2.6"`; `resolveApiKey`
  also checks `MOONSHOT_API_KEY` as fallback for `kimi` provider.
- `src-tauri/scripts/generate.ts`: Model type updated; MOONSHOT_API_KEY aliased
  to KIMI_API_KEY after `.env` load.
- `src/screens/Settings.tsx`: Kimi `envVar` updated to
  `"MOONSHOT_API_KEY or KIMI_API_KEY"`, `displayName` → `"Moonshot / Kimi API key"`.

**Fix 4 — Export MR as .docx:**
- `npm install docx` added to `package.json`.
- `src/generators/export-mr-docx.ts` NEW: builds Word doc with title (28pt bold),
  subtitle (14pt), Metadata Review heading, compiled-by line, HR, then sections
  1–15 each as a Heading 1 (FAO green `#1B4F23`), claim paragraphs, grey source
  lines, HR separator. Footer with page numbers. Writes to
  `exports/<iso3>-mr-<date>.docx`.
- `src-tauri/scripts/export.mjs`: added `mr-docx` branch calling `exportMrDocx`.
- `src/screens/MrReview.tsx`: "Export MD" button is now two side-by-side buttons
  ("Export MD" + "Export DOCX"), each with its own `exporting` state.

**Verification:** `npx tsc --noEmit` → zero errors.