# AgCensus Compiler — Design specification

This document is the authoritative design reference for the AgCensus Compiler project. Read it in full before generating, modifying, or proposing any code. When the design is ambiguous or silent, ask before assuming. Do not invent architecture not described here.

## 1. What the app does

AgCensus Compiler is a desktop application used by FAO statisticians to produce two structured deliverables from a country's agricultural census documents:

- A **Metadata Review (MR)** — a fifteen-section narrative describing how the census was conducted, in a fixed structure defined by the FAO MR prompt.
- **Tables of Main Results (TMR)** — a populated Excel workbook of twenty-six sub-tables with WCA 2020 concept mapping, source citations per cell, and a notes column recording derivations, unit conversions, and deviations.

The unit of work is a **country project**: one country, one census reference year, one set of source documents, one MR draft, one TMR draft, one audit log. Staff process roughly 15–25 countries per year while the WCA 2020 round closes.

## 2. Non-negotiable principles

These principles override any other design instinct and constrain every implementation decision.

**Traceability is the primary product.** Every figure in the TMR and every claim in the MR must trace to a specific page or table in a specific source document. A generation without source citations is a defect, not an inconvenience.

**Local-only, single user.** No cloud, no shared backend, no sync. A country project is a directory on the staff member's laptop. Collaboration happens by exporting and importing zipped project bundles. The API keys are the only thing that goes over the network, and only to the chosen LLM provider.

**Provider-agnostic.** The app supports DeepSeek and Kimi (Moonshot) as LLM providers for v1, both via their OpenAI-compatible APIs. Adding a third provider must not require changing anything outside the provider abstraction layer.

**Human in the loop.** The app produces drafts; it does not produce final outputs. Every cell, every section, every flag exists to be reviewed and accepted, edited, or rejected by a statistician. The UI is designed around review and editing, not around one-click generation.

**Audit trail is append-only.** Every generation, every edit, every approval, every API call gets a timestamped entry in the project's audit log. This log is what defends the output when a government statistician asks "where did this number come from?"

## 3. Technology stack

- **Shell:** Tauri 2.x — Rust core, web-based UI, ~15 MB installer, native OS integration, secure secret storage.
- **Frontend:** React + TypeScript + Vite. Tailwind CSS for styling. No UI framework beyond shadcn-style primitives.
- **State:** Zustand for app-level state. Country project data is read from disk (see schema below), not held in a global store.
- **PDF parsing:** `pdf-parse` (Node) for text PDFs, `tesseract.js` for OCR when needed. The Rust side may use `pdf-extract` if Node parsing is too slow on large corpora.
- **Storage:** Plain files on disk in a deterministic schema. No SQLite, no database, no migrations. JSON for structured data, Markdown for narrative drafts, XLSX for the TMR template.
- **API clients:** A single TypeScript module wraps both DeepSeek and Kimi behind one interface. Both expose OpenAI-compatible endpoints, so a single OpenAI-format client library handles both with different base URLs.
- **Secret storage:** Tauri's secure store (OS keychain). API keys never touch disk in plaintext.
- **Distribution:** Signed installers for macOS, Windows, and Linux, published on an FAO release page. Auto-update via Tauri's built-in updater pointing at the FAO release server.

## 4. Country project schema

A country project is a single directory under `~/Documents/AgCensus/<country>-<year>/`. The structure is deterministic and must not deviate.

```
Nepal-2021/
├── manifest.json
├── sources/
│   ├── 01-main-report.pdf
│   ├── 02-technical-report.pdf
│   ├── 03-questionnaire-form-2.pdf
│   ├── 04-online-tables-snapshot.html
│   └── _index.json
├── evidence/
│   ├── pages/
│   │   ├── 01-main-report-p001.json
│   │   └── ...
│   ├── tables/
│   │   ├── 01-main-report-t023-livestock-by-type.json
│   │   └── ...
│   └── _evidence.json
├── drafts/
│   ├── mr/
│   │   ├── current.md
│   │   ├── history/
│   │   └── _claims.json
│   └── tmr/
│       ├── current.xlsx
│       ├── history/
│       └── _cells.json
├── audit/
│   └── 2026-05-18-events.jsonl
└── certification/        # only present if certified gold-standard
    └── gold-standard.json
```

### 4.1 manifest.json

Identity card for the project. Schema:

```json
{
  "schema_version": "1.0",
  "country": "Nepal",
  "country_iso3": "NPL",
  "census_round": "WCA 2020",
  "census_name": "National Sample Census of Agriculture 2021/2022",
  "reference_year": "2021/2022",
  "reference_day": "day of interview",
  "methodology_type": "sample-based",
  "statistical_unit": "agricultural holding",
  "lower_size_threshold": "0.01272 ha or 0.01355 ha or 1 head cattle/buffalo or 5 sheep/goats or 20 poultry",
  "national_statistical_office": "National Statistics Office (NSO), Nepal",
  "source_documents": [
    {
      "id": "01-main-report",
      "title": "NSCA 2021/2022 — Main Report",
      "url": "https://agricensusnepal.gov.np/...",
      "retrieved": "2026-05-18",
      "language": "en"
    }
  ],
  "compiled_by": "a.statistician@fao.org",
  "compiled_at": "2026-05-18T14:02:00Z",
  "app_version": "1.0.0"
}
```

### 4.2 sources/

Raw documents as obtained from the NSO. The `_index.json` records, per file: the origin URL, retrieval date, SHA-256 hash, language, page count or row count, and a one-line description. Hashes are what make projects reproducible across machines.

### 4.3 evidence/

Parsed and indexed form of the sources. Each source page becomes one JSON file under `pages/` with extracted text, layout hints, page number, and source document reference. Each extracted table becomes one JSON file under `tables/` with row/column structure preserved.

A page JSON looks like:

```json
{
  "page_id": "01-main-report-p014",
  "source_doc": "01-main-report",
  "page_number": 14,
  "text": "Statistical unit. The statistical unit was the agricultural holding, defined as...",
  "headings": ["5. Scope of the census and definition of the statistical unit"],
  "tables_on_page": ["01-main-report-t007"],
  "language": "en"
}
```

A table JSON looks like:

```json
{
  "table_id": "01-main-report-t023-livestock-by-type",
  "source_doc": "01-main-report",
  "page_number": 87,
  "title": "Livestock, by type",
  "columns": ["", "Holdings", "Head"],
  "rows": [
    {"label": "Cattle", "values": [1708421, 4612472]},
    {"label": "Buffalo", "values": [1417028, 2923132]}
  ],
  "units": {"Holdings": "number of holdings", "Head": "head"},
  "extraction_confidence": 0.97
}
```

The `_evidence.json` is the index that lets generators ask "give me all evidence relevant to livestock by type" without re-parsing PDFs.

### 4.4 drafts/

`current.md` and `current.xlsx` are what the staff member sees in the UI. `history/` keeps every prior generation timestamped with the prompt version and model used. The `_claims.json` and `_cells.json` files are the structured backbone:

`_claims.json` for the MR:
```json
{
  "section_5": {
    "claims": [
      {
        "claim_id": "5.1",
        "text": "The census scope mainly covers crop and livestock production activities.",
        "sources": [{"page_id": "01-main-report-p012", "passage_offset": [148, 232]}],
        "deviation_flags": [],
        "human_edited": false
      }
    ]
  }
}
```

`_cells.json` for the TMR:
```json
{
  "table_13_livestock_by_type": {
    "cattle_head": {
      "value": 4612472,
      "unit": "head",
      "sources": [{"table_id": "01-main-report-t023-livestock-by-type", "row": "Cattle", "column": "Head"}],
      "derived": false,
      "flags": [],
      "human_edited": false
    }
  }
}
```

### 4.5 audit/

JSONL append-only log. One event per line. Event types: `project_created`, `source_added`, `evidence_indexed`, `generation_started`, `generation_completed`, `section_edited`, `cell_edited`, `flag_raised`, `flag_resolved`, `export`, `certified_gold_standard`.

Every generation event records: prompt version, model used, provider, input token count, output token count, cost in USD, wall time.

### 4.6 certification/

Present only when a project is promoted to gold standard. Contains the certifier's name, date, rationale, and a hash of the evidence store at the moment of certification. Promotes the project to read-only and makes it available in the evaluation harness.

## 5. The provider abstraction

A single TypeScript module at `src/providers/index.ts` exposes:

```typescript
type Provider = "deepseek" | "kimi";
type Model =
  | "deepseek-v4-flash"
  | "deepseek-v4-pro"
  | "kimi-k2.6-non-thinking"
  | "kimi-k2.6-thinking";

interface GenerateOptions {
  systemPrompt: string;
  userPrompt: string;
  model: Model;
  maxTokens?: number;
  temperature?: number;
  responseFormat?: "text" | "json";
  onStream?: (chunk: string) => void;
}

interface GenerateResult {
  text: string;
  inputTokens: number;
  outputTokens: number;
  costUsd: number;
  wallTimeMs: number;
  provider: Provider;
  model: Model;
  finishReason: "stop" | "length" | "error";
}

async function generate(options: GenerateOptions): Promise<GenerateResult>;
```

The module internally routes to the right base URL (`https://api.deepseek.com/v1` or `https://api.moonshot.ai/v1`), pulls the API key from the OS keychain, applies retry logic with exponential backoff, calculates cost from the published pricing table baked into the app, and returns a normalised result.

Both providers expose OpenAI-compatible APIs, so a single OpenAI-format client library (e.g. `openai` npm package with custom `baseURL` and `apiKey`) handles both. Different model strings select different endpoints. Pricing table is loaded from `src/providers/pricing.json` and used both for cost calculation and for the cost-estimate UI before each generation.

Key thinking-mode handling: Kimi's K2.6 supports thinking and non-thinking modes via a flag on the request. DeepSeek V4 routes thinking via separate model strings. The abstraction hides this behind the four `Model` values.

## 6. MR generation

The MR prompt (fifteen-section, narrative, strict citation) is stored at `src/prompts/mr-v1.3.md` and loaded at generation time. The generator runs section by section, not in one shot, because:
- Each section is small and traceable.
- Failures in one section don't poison others.
- Regeneration of one section is a common workflow.

For each section:
1. Build a context window of relevant evidence (pages mentioning the section's themes — historical outline, legal basis, etc.) using simple keyword matching against the evidence index. Cap at the model's context limit minus prompt overhead.
2. Call `generate()` with the MR system prompt, the section-specific instructions, and the assembled evidence.
3. Parse the response into claims (sentences with attributed sources). The prompt instructs the model to emit JSON with claims and source references, which the app stores in `_claims.json`.
4. Render the claims as Markdown prose into `current.md`.

If the model emits text without parseable claim attribution, the app flags it and falls back to text-only output for that section, with a warning in the UI.

## 7. TMR generation

The TMR template is the FAO Excel file at `src/templates/TMR_Template_WCA2020.xlsx`, with twenty-six sub-tables in two column blocks.

The WCA 2020 concept registry at `src/concepts/wca-2020.json` encodes, for each sub-table:
- The row labels and column headers
- The measurement unit per column
- The universe (all holdings, household sector only, etc.)
- The validation rules (subtotals, cross-table consistency)
- The standard unit conversions

The generator runs sub-table by sub-table:
1. Identify candidate source tables in the evidence store that match the sub-table's themes.
2. For each cell, ask the model to either populate it from the candidate tables, derive it (with calculation shown), or mark it unavailable using the prescribed missing-value codes (`..`, `…`, `0`, `*`, `c`).
3. Run validation: subtotals reconcile, cross-table totals match.
4. Surface any failures as flags in the issues queue.

Unit conversions (acres to hectares, etc.) are computed in the app, not by the model. The model proposes "this is in acres"; the app converts. This avoids the entire class of LLM arithmetic errors.

## 8. The evaluation harness

The harness compares a candidate generation against a certified gold-standard country project along four axes:
- **Content match** (MR): does the candidate cover the same factual claims as the gold version?
- **Citation fidelity** (MR): do the candidate's claims trace to sources the gold version also used?
- **Cell coverage** (TMR): what percentage of populated gold cells did the candidate also populate?
- **Value accuracy** (TMR): of cells populated by both, how many match within tolerance?

A judge model — chosen separately from the candidate model, ideally from a different provider — scores each axis using a strict rubric. The harness shows raw scores, not a composite. The methodologist's approval is required to publish a prompt change to the FAO repository.

Inputs to a run:
- One or more gold-standard countries
- A baseline prompt version (the current FAO official)
- A candidate prompt version (the local draft being tested)
- A candidate model and a judge model
- Options: parallel execution, source-parsing cache, report generation

The harness writes results to `<project>/evaluations/<run-id>/` with the full diff, scores, and a judge-written summary.

## 9. UI structure

The Tauri app opens to a country project list. Each project is a card showing country, year, status (working / gold standard / archived), last-modified date.

Per-project, the screens are:
- **Overview**: status of MR and TMR, open issues, sources indexed.
- **Sources**: list of source documents with retrieval URL and hash, add/remove sources.
- **MR draft**: section-by-section review interface (one section at a time, with source passages alongside the prose).
- **TMR draft**: spreadsheet-style view of the twenty-six sub-tables with cell-level source inspection.
- **Issues**: prioritised queue of flags requiring human resolution.
- **Audit log**: chronological view of all events.

Two additional global screens, not per-project:
- **Prompt library**: edit MR and TMR prompts, compare versions, run evaluations.
- **Settings**: API keys, model preferences, project folder location.

Mockups for the main screens have been developed in the design conversation; refer to those as visual references when building.

## 10. Error and edge case handling

**API failures.** Retry with exponential backoff up to three attempts. After three failures, surface the error in the UI and pause the generation. Partial results are preserved.

**Context limit exceeded.** When the source corpus is larger than the model's context window, the app chunks the corpus by sub-section relevance. If chunking is insufficient (very large corpora), the UI offers to switch to a model with a larger context (DeepSeek V4 has 1M context; Kimi K2.6 has 262K).

**Bad PDFs.** When PDF parsing produces low-confidence text (likely scanned, OCR fallback triggered), the source is flagged in the corpus view. OCR errors do not block generation but reduce the confidence score on dependent claims and cells.

**Bilingual sources.** When a source is detected as non-English, the app indexes it in the original language and translates relevant passages on demand via the LLM when generating. The translation is logged and shown alongside the original.

**Network unavailable.** All generation requires network. The app detects offline state and queues nothing — it surfaces the disconnection and waits. Partial drafts and edits work offline.

**Laptop sleep mid-generation.** The Tauri shell handles app-level pause on system sleep. In-flight requests complete or fail gracefully; the run state is persisted to disk before sleep so resume is clean.

## 11. Out of scope for v1

- Multi-user collaboration on the same project (use export/import bundles instead)
- Cloud sync (intentional — projects are local)
- Anthropic API support (deferred to v2 after DeepSeek and Kimi pilots prove the architecture)
- Self-hosted model deployment (deferred to v2 / FAO IT infrastructure decision)
- Web-based UI (Tauri only)
- Mobile (Tauri only, desktop)
- Automated prompt updates from the FAO repository (manual notification + opt-in in v1)
- Real-time collaborative editing
- Plug-in architecture for custom validators

## 12. Build order

Work in this order. Do not skip ahead.

1. Project skeleton (Tauri + React + TypeScript), `PROJECT.md`, this `DESIGN.md` in repo
2. Provider abstraction module with integration tests against both APIs
3. Country project schema — disk layout, manifest reader/writer, evidence store reader/writer
4. PDF parsing pipeline producing evidence/pages and evidence/tables for Nepal and Pakistan corpora
5. MR generator for section 1 (Historical outline) end-to-end, working for Nepal and Pakistan
6. MR generator for sections 2–15
7. TMR generator for sub-table 1 (Holdings and area by legal status) end-to-end, working for Nepal and Pakistan
8. TMR generator for sub-tables 2–26
9. Tauri shell with country project list and per-project screens
10. Section review UI for MR
11. Cell review UI for TMR
12. Issues queue
13. Audit log writing and viewing
14. Import/export bundles
15. Evaluation harness — comparison engine
16. Evaluation harness — UI and run-in-progress view
17. Prompt library with editing and version control
18. Settings, API key management, cost estimation
19. Cross-platform installers (macOS, Windows, Linux), code signing, auto-update
20. Polish, accessibility, internationalisation hooks

Each step has acceptance criteria captured in `tests/`. Do not consider a step done until its tests pass for both Nepal and Pakistan corpora.

## 13. Reference materials

Available in the project repo:
- `references/mr-prompt-v1.3.md` — the canonical MR prompt
- `references/tmr-prompt-v1.3.md` — the canonical TMR prompt
- `references/TMR_Template_WCA2020.xlsx` — the FAO TMR template
- `references/wca-2020-volume-1.pdf` — the WCA 2020 conceptual reference
- `references/pakistan-2024/` — Pakistan gold-standard corpus, MR, TMR
- `references/nepal-2021/` — Nepal gold-standard corpus, MR, TMR
- `references/design-conversation.md` — the full design conversation that produced this spec

Read these before generating code that touches the relevant area.
