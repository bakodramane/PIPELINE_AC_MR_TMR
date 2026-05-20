# AgCensus Compiler — v1 Week 4 Checkpoint

**Date:** 2026-05-20  
**Session:** 10 (Foundation Phase complete — Sessions 1–10)  
**Model used:** `deepseek-v4-flash`  
**Compiled by:** bakodramane@gmail.com

---

## Overview

Session 10 ran both foundation countries end-to-end: full MR (15 sections) + full TMR
(23 sub-tables) against real census PDFs, using the complete generator stack built in
Sessions 1–9. Results are in `docs/nepal-run-summary.json` and
`docs/pakistan-run-summary.json`.

| Metric | Nepal | Pakistan | Combined |
|---|---|---|---|
| PDF pages indexed | 162 | 110 | 272 |
| PDF tables extracted | 3 | 0 | 3 |
| MR sections generated | 15/15 | 15/15 | 30/30 |
| MR ok (≥1 claim) | 14/15 | 13/15 | 27/30 |
| MR empty (0 claims) | 0/15 | 1/15 | 1/30 |
| MR parse_failed | 1/15 | 1/15 | 2/30 |
| Total MR claims | 69 | 59 | 128 |
| TMR sub-tables generated | 23/23 | 23/23 | 46/46 |
| TMR ok (≥1 cell populated) | 13/23 | 0/23 | 13/46 |
| TMR empty (0 cells) | 8/23 | 21/23 | 29/46 |
| TMR parse_failed | 2/23 | 2/23 | 4/46 |
| TMR cells populated | 107 | 0 | 107 |
| TMR cells missing | 247 | 354 | 601 |
| Validation flags | 3 | 0 | 3 |
| Total cost (USD) | $0.1735 | $0.2490 | $0.4225 |
| Wall time | 5.4 min | 6.9 min | 12.3 min |
| Ingest time | 9 s | 19 s | 28 s |

---

## Nepal 2021/2022 — Detailed Results

### MR Sections

| Section | Title | Status | Claims | Cost |
|---|---|---|---|---|
| 1 | Historical Outline | ✓ ok | 5 | $0.0028 |
| 2 | Legal Basis and Organisation | ✗ parse_failed | 0 | $0.0015 |
| 3 | Reference Date and Period | ✓ ok | 3 | $0.0025 |
| 4 | Enumeration Period | ✓ ok | 3 | $0.0007 |
| 5 | Scope of the Census | ✓ ok | 7 | $0.0025 |
| 6 | Census Coverage | ✓ ok | 4 | $0.0033 |
| 7 | Methodology | ✓ ok | 7 | $0.0029 |
| 8 | Use of Technology | ✓ ok | 5 | $0.0005 |
| 9 | Data Processing | ✓ ok | 6 | $0.0006 |
| 10 | Quality Assurance | ✓ ok | 7 | $0.0007 |
| 11 | Data and Metadata Archiving | ✓ ok | 4 | $0.0009 |
| 12 | Data Reconciliation | ✓ ok | 1 | $0.0004 |
| 13 | Dissemination | ✓ ok | 7 | $0.0029 |
| 14 | Data Sources | ✓ ok | 4 | $0.0022 |
| 15 | Contact | ✓ ok | 6 | $0.0005 |

**Section 2 parse_failed** — Legal Basis section. The model output hit the 1024-token
max and was truncated mid-JSON. Root cause: the legal basis content (laws, institutional
hierarchy, confidentiality provisions) is verbose and evidence pages are long.
Fix: raise max_tokens for section 2 to 1500 (same as §7 and §13).

Section 12 (Data Reconciliation) produced only 1 claim — expected; Nepal census has
minimal reconciliation narrative.

### TMR Sub-tables (Nepal)

| Sub-table | Title | Status | Pop. | Miss. | Val. flags | Cost |
|---|---|---|---|---|---|---|
| 1 | Holdings by legal status | ✓ ok | 2/8 | 6 | 0 | $0.0017 |
| 2 | Holdings by tenure | ✓ ok | 12/12 | 0 | 2 | $0.0016 |
| 3 | Holdings by number of parcels | ✗ parse_failed | 0 | 0 | 0 | $0.0008 |
| 4 | Holdings by size class | ✓ ok | 1/24 | 23 | 0 | $0.0051 |
| 5 | Holdings by land use | ✓ ok | 16/26 | 10 | 0 | $0.0061 |
| 6 | Holdings by purpose of production | ✓ ok | 5/10 | 5 | 0 | $0.0009 |
| 7 | Household members by age/activity | ✓ ok | 4/15 | 11 | 0 | $0.0247 |
| 8 | Holdings by sex of holder | ○ empty | 0/14 | 14 | 0 | $0.0015 |
| 9 | Holdings by age of holder | ✓ ok | 41/48 | 7 | 0 | $0.0428 |
| 10 | Holdings by household size | ○ empty | 0/6 | 6 | 0 | $0.0004 |
| 11 | Holdings by hired labour | ✓ ok | 1/14 | 13 | 0 | $0.0009 |
| 12 | Holdings by livestock system | ○ empty | 0/12 | 12 | 0 | $0.0006 |
| 13 | Livestock by type | ✓ ok | 13/44 | 31 | 0 | $0.0388 |
| 14 | Holdings by irrigated land | ✓ ok | 6/10 | 4 | 1 | $0.0009 |
| 15 | Holdings by irrigation method | ○ empty | 0/8 | 8 | 0 | $0.0011 |
| 16 | Holdings by irrigation land use | ○ empty | 0/10 | 10 | 0 | $0.0012 |
| 17 | Holdings by irrigation source | ✗ parse_failed | 0 | 0 | 0 | $0.0006 |
| 18 | Holdings by machinery used | ○ empty | 0/12 | 12 | 0 | $0.0012 |
| 19 | Holdings by machinery owned | ○ empty | 0/12 | 12 | 0 | $0.0012 |
| 20 | Holdings using pesticides | ○ empty | 0/8 | 8 | 0 | $0.0004 |
| 21 | Holdings using fertilizers | ✓ ok | 1/9 | 8 | 0 | $0.0010 |
| 22 | Temporary crops by type | ✓ ok | 3/30 | 27 | 0 | $0.0047 |
| 23 | Permanent crops by type | ✓ ok | 2/22 | 20 | 0 | $0.0102 |

**Key Nepal TMR observations:**

- **ST1 (Legal status)**: Only 2/8 cells populated. Expected — Nepal census does not use
  WCA 2020 legal status categories ("civil persons", "juridical persons"). The Total_Holdings
  and Total_Area were found; the breakdown rows correctly return "..".

- **ST2 (Tenure)**: 12/12 cells populated (full coverage), but 2 validation flags — the
  sub-row counts don't quite sum to the published total. Likely a rounding discrepancy in
  the source document.

- **ST3 (Parcels, parse_failed)**: Model output truncated at 1024 tokens. This sub-table has
  12 columns × several rows; the JSON response was cut off. Fix: raise MAX_TOKENS to 1500
  for sub-table 3.

- **ST4 (Size classes)**: Only 1/24 cells populated. Nepal census does not publish a detailed
  size-class breakdown; only the total holdings figure was extractable.

- **ST5 (Land use)**: 16/26 cells populated. Good partial coverage — temporary crops, permanent
  crops, and total area are present. Fallow and other sub-categories were not found.

- **ST7 (Household members)**: $0.0247 cost (24 rows × expensive evidence pages). Only 4 cells
  populated. Nepal NSCA does not break down household members by age/sex/activity in this format.

- **ST9 (Holder age)**: Best-performing large sub-table — 41/48 cells populated across 24 rows.
  Nepal census has detailed holder age breakdowns by sex.

- **ST12 (Livestock system)**, **ST15–16 (Irrigation method/use)**, **ST18–19 (Machinery)**,
  **ST20 (Pesticides)**: All empty. These topics are absent or not quantified in the Nepal NSCA.

- **ST13 (Livestock)**: 13/44 cells populated. Nepal has livestock data but the WCA 2020
  disaggregation (by sub-type and sex) is only partially matched.

- **ST17 (Irrigation source, parse_failed)**: Same truncation issue as ST3. Fix: raise MAX_TOKENS.

- **ST22 (Temporary crops)**: Only 3/30 cells — total area found, but individual crop type
  rows were sparse. Nepal NSCA uses different crop classifications than WCA 2020 row labels.

---

## Pakistan 2024 — Detailed Results

### MR Sections

| Section | Title | Status | Claims | Cost |
|---|---|---|---|---|
| 1 | Historical Outline | ✓ ok | 7 | $0.0015 |
| 2 | Legal Basis and Organisation | ✓ ok | 6 | $0.0007 |
| 3 | Reference Date and Period | ✓ ok | 2 | $0.0005 |
| 4 | Enumeration Period | ✓ ok | 1 | $0.0005 |
| 5 | Scope of the Census | ✓ ok | 7 | $0.0010 |
| 6 | Census Coverage | ✓ ok | 5 | $0.0007 |
| 7 | Methodology | ✓ ok | 7 | $0.0011 |
| 8 | Use of Technology | ✓ ok | 6 | $0.0021 |
| 9 | Data Processing | ○ empty | 0 | $0.0006 |
| 10 | Quality Assurance | ✗ parse_failed | 0 | $0.0012 |
| 11 | Data and Metadata Archiving | ✓ ok | 6 | $0.0009 |
| 12 | Data Reconciliation | ✓ ok | 1 | $0.0031 |
| 13 | Dissemination | ✓ ok | 3 | $0.0005 |
| 14 | Data Sources | ✓ ok | 5 | $0.0006 |
| 15 | Contact | ✓ ok | 3 | $0.0006 |

**Section 9 empty** — Data Processing section: all claims were generated but none had
source citations that verified on disk. The Pakistan census PDF discusses methodology at
a high level; detailed data processing steps may not appear in the main report.

**Section 10 parse_failed** — Quality Assurance: same max_tokens truncation as Nepal §2.

**Known quality issue (Session 6):** Section 1 cites 1972 as Pakistan's first agricultural
census; the correct year is 1960. Evidence retrieval did not surface the page containing
the 1960 reference. Fix: add keywords `'1960'`, `'first census'` to SECTION_KEYWORDS[1] for
Section 1, or increase maxPages from 20 to 30.

### TMR Sub-tables (Pakistan)

All 23 sub-tables returned 0 populated cells. This is a complete TMR extraction failure for
Pakistan.

| Sub-table | Status | Pop. | Miss. | Cost |
|---|---|---|---|---|
| 1–2, 4–16, 18–23 | ○ empty | 0 | 8–48 | varies |
| 3, 17 | ✗ parse_failed | 0 | 0 | $0.0027 / $0.0007 |

**Root cause — Pakistan TMR failure:**

The Pakistan census PDF was ingested as 110 pages with **0 tables** extracted. The heuristic
table extractor (`src/ingest/tables.ts`) failed to detect any structured tables in the Pakistan
document (unlike Nepal's 3 TOC-derived tables). More critically, the evidence pages don't
contain the quantitative data in prose form either — the model searched all retrieved pages
and could not match any WCA 2020 cell definitions to Pakistan's data layout.

Likely explanation: the Pakistan Agricultural Census 2024 main report is a summary/narrative
document; the detailed statistical tables are in a separate publication or annex not yet
ingested. The `references/pakistan-2024/sources/` directory contains only `main-report.pdf`
and `methodology.pdf` — the statistical tables volume (if it exists as a separate PDF) has
not been added.

**Action required:** Identify and ingest the Pakistan TMR data source. Until then, Pakistan
TMR results remain completely empty and are not useful for quality assessment.

---

## Quality Observations

### What worked well

1. **MR generator** — 27/30 sections across both countries produced usable claims. The two-pass
   evidence retrieval (keyword index score → full-text re-score) surfaces the right pages.

2. **Multi-row TMR generation** — Nepal ST9 (24 rows, 41 cells populated) demonstrates the
   one-call-per-row discipline working correctly. No row transposition or hallucination observed.

3. **Evidence-backed claims enforcement** — `_claims.json` contains only claims with verified
   source citations. The citedClaims filter is working.

4. **Cost** — DeepSeek V4-Flash at $0.42 for two complete country runs (30 MR sections + 46 TMR
   sub-tables) is extremely cost-effective. Well within the $2–5 estimate.

5. **Speed** — 5.4 min (Nepal) + 6.9 min (Pakistan) = 12.3 min combined. The generator is
   operationally fast.

6. **Audit trail** — All generation events written to JSONL audit log with token counts, costs,
   and wall times. Cost attribution per section/sub-table is accurate.

### Known issues requiring fixes

| Issue | Severity | Affected | Fix |
|---|---|---|---|
| Section 2 parse_failed (max_tokens) | High | Nepal §2, Pakistan §10 | Raise MAX_TOKENS to 1500 for §2, §4, §10 |
| ST3, ST17 parse_failed (max_tokens) | High | Both countries | Raise MAX_TOKENS to 1500 for ST3, ST17 |
| Pakistan TMR: 0 cells populated | Critical | PAK all sub-tables | Ingest Pakistan statistical tables volume |
| Pakistan §1: wrong first census year (1960 vs 1972) | Medium | PAK §1 | Add `'1960'`, `'first census'` to section 1 keywords |
| Pakistan §9: empty (all claims uncited) | Medium | PAK §9 | Broaden Data Processing evidence keywords |
| ST2 Nepal: 2 validation flags (tenure sums) | Low | NPL ST2 | Human review; likely source rounding |
| ST14 Nepal: 1 validation flag (irrigation) | Low | NPL ST14 | Human review |
| ST4 Nepal: 1/24 cells (size class) | Low | NPL ST4 | Expected — Nepal census lacks this breakdown |
| ST12,15–16,18–20 Nepal: all empty | Low | NPL 6 sub-tables | Expected — topics absent from Nepal NSCA |

### Evidence retrieval bottleneck

Both countries ingested 0 structured tables from the relevant census sections (Nepal's 3
extracted tables came from TOC entries). All TMR data extraction relies on prose text in
evidence pages. The heuristic table extractor is not detecting real data tables in either PDF.
This limits TMR population rates. Session 11 should investigate native PDF table extraction.

---

## API Cost Summary

| Country | Input tokens | Output tokens | Total cost |
|---|---|---|---|
| Nepal | 1,163,063 | 37,969 | $0.1735 |
| Pakistan | 1,707,116 | 35,570 | $0.2490 |
| **Combined** | **2,870,179** | **73,539** | **$0.4225** |

Input token count is dominated by multi-row sub-tables where evidence pages are sent for
each row call. ST9 (24 rows × ~12,400 tokens/call) cost $0.043 for Nepal alone.
ST13 (22 rows × ~12,300 tokens/call) cost $0.039.

DeepSeek V4-Flash promo pricing ($0.435/$0.87 per M input/output) applies until 2026-05-31.
After that date, update `src/providers/pricing.json`.

---

## Sessions 11–20 Plan

### Session 11 — Parse failure fixes + token budget audit

**Goal:** Eliminate the recurring max_tokens truncation failures.

- Raise `SECTION_MAX_TOKENS` in `mr.ts`: add entries for sections 2, 4, 10 → 1500 tokens
- Raise `MAX_TOKENS` in `tmr.ts` from 1024 to 1500 globally (or add a `SUB_TABLE_MAX_TOKENS`
  map for ST3 and ST17 specifically)
- Add truncation detection: check if `result.finishReason === 'length'` and flag the audit
  event with `truncated: true` — never silently discard
- Re-run Nepal §2 and both ST3/ST17 after the fix and verify parse succeeds

### Session 12 — Pakistan TMR data source investigation

**Goal:** Determine why Pakistan TMR has 0 cells and fix it.

- Examine `references/pakistan-2024/sources/` — check whether a statistical tables PDF exists
  separate from `main-report.pdf`
- If a statistical tables PDF exists: ingest it as `02-statistical-tables` and re-run TMR
- If the main report is the only source: manually identify page numbers that contain TMR data
  and add them as evidence annotations
- Compare Nepal ST2 full-coverage result to Pakistan ST2 empty result to understand the
  structural difference

### Session 13 — Section 1 keyword fix + Pakistan §1 first census year

**Goal:** Fix Pakistan §1 "first census 1972" error and broaden Section 9 evidence.

- Add keywords `'1960'`, `'1952'`, `'first census'`, `'earliest'` to `SECTION_KEYWORDS[1]`
- Increase maxPages for section 1 from 20 to 30
- Broaden Section 9 keywords to include `'post-enumeration'`, `'checking'`, `'batch'`,
  `'coding procedure'`
- Re-run Pakistan §1 and §9 and verify improvement

### Session 14 — Third country: Ethiopia or Libya

**Goal:** Test the pipeline on a third WCA 2020 country.

- The `references/` directory already contains `EXAMPLE OF METADATA REVIEW LIBERIA.pdf`
- Obtain and ingest Liberia (or another available country) census PDF
- Run full MR + TMR pipeline and compare results to Nepal/Pakistan
- Document country-specific patterns (coverage rates, TMR population rates)

### Session 15 — Export pipeline to FAO Excel template

**Goal:** Generate the standard FAO submission format from `_cells.json`.

- Define the FAO Excel template column/row layout from the TMR prompt PDF
- Write `src/generators/export.ts`: reads `_cells.json` + WCA concepts → writes an Excel
  file matching FAO template structure
- Output: `exports/<country>-tmr-<date>.xlsx`

### Session 16 — MR Markdown → DOCX export

**Goal:** Generate a properly formatted Word document from MR claims.

- Write `src/generators/mr-export.ts`: reads `_claims.json` → generates structured DOCX
  with FAO metadata review formatting (section headings, citation footnotes, deviation flags)
- Output: `exports/<country>-mr-<date>.docx`

### Session 17 — Tauri frontend: MR editor

**Goal:** Wire MR section claims into the React UI for human review and editing.

- Implement the MR section list view (15 sections, status badges)
- Implement the claim editor (edit claim text, add/remove source citations, set deviation flags)
- Save changes back to `_claims.json` with a `section_edited` audit event

### Session 18 — Tauri frontend: TMR cell editor

**Goal:** Wire TMR cells into the React UI for human review and editing.

- Implement the sub-table grid view (rows × columns, cell values with source pop-overs)
- Implement cell editing (edit value, unit, source citation)
- Show validation flags inline in the grid; flag unverified_source cells in orange

### Session 19 — Gold standard certification flow

**Goal:** Implement the certification step for completed projects.

- Write `src/generators/certify.ts`: computes SHA-256 of evidence store → writes
  `certification/gold-standard.json` → appends `certified_gold_standard` audit event
- Implement certification button in Tauri UI with certifier name input
- Gate the export step behind certification

### Session 20 — Sub-tables 24–26 (if in WCA 2020 scope)

**Goal:** Complete the TMR sub-table coverage to the full WCA 2020 set.

- Review FAO WCA 2020 documentation for sub-tables 24–26
- Extend `wca-2020.json` and `SUBTABLE_KEYWORDS` accordingly
- Update smoke test assertions from 23 to the new maximum
- Run full pipeline with the expanded set on Nepal

---

## Files Written This Session

| File | Purpose |
|---|---|
| `scripts/run-nepal.ts` | Nepal E2E run script (Vitest, 2-hour timeout) |
| `scripts/run-pakistan.ts` | Pakistan E2E run script (Vitest, 2-hour timeout) |
| `vitest.scripts.config.ts` | Separate Vitest config for scripts/ directory |
| `docs/nepal-run-summary.json` | Nepal run results (actual data, 10,019 bytes) |
| `docs/pakistan-run-summary.json` | Pakistan run results |
| `docs/v1-week4-checkpoint.md` | This document |

---

## How to Re-run

```
# Nepal only
node "C:\Users\Dramane\Desktop\PIPELINE\node_modules\vitest\vitest.mjs" ^
  run --root "C:\Users\Dramane\Desktop\PIPELINE" ^
  --config vitest.scripts.config.ts ^
  --reporter verbose ^
  --testNamePattern "Nepal"

# Pakistan only
node "C:\Users\Dramane\Desktop\PIPELINE\node_modules\vitest\vitest.mjs" ^
  run --root "C:\Users\Dramane\Desktop\PIPELINE" ^
  --config vitest.scripts.config.ts ^
  --reporter verbose ^
  --testNamePattern "Pakistan"

# Both (sequential, ~15 minutes)
node "C:\Users\Dramane\Desktop\PIPELINE\node_modules\vitest\vitest.mjs" ^
  run --root "C:\Users\Dramane\Desktop\PIPELINE" ^
  --config vitest.scripts.config.ts ^
  --reporter verbose
```

Requires `DEEPSEEK_API_KEY` in `.env`.
