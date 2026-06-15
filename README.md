# Ag Census MR TMR Compiler

A desktop application that generates FAO World Programme for the Census of Agriculture (WCA 2020) Metadata Reviews and Tables of Main Results from national agricultural census source documents using large language model APIs.

## Overview

The Ag Census MR TMR Compiler is designed to assist FAO statisticians in producing two standardised outputs from a country's agricultural census documents. It ingests national census PDFs and Excel workbooks, indexes their content into a searchable evidence store, and uses configurable LLM providers to generate a fifteen-section Metadata Review (MR) and a set of twenty-three WCA 2020 sub-tables forming the Table of Main Results (TMR). Every generated claim and every populated cell is traceable to a specific page or table in the source documents.

The application is local-only and single-user. Each country project lives in a directory on the statistician's machine, containing the source documents, the indexed evidence, the generated drafts, and an append-only audit log. The application produces drafts, not final outputs — every section and every cell exists to be reviewed, edited, and approved by a statistician before export.

Outputs are exported as a Word document (Metadata Review, available in a cited-sources draft and a clean submission version) and an Excel workbook (Tables of Main Results). Both are generated from the reviewed and approved content within the application.

## Key features

**Project management.** Create country projects, each storing source documents, generated drafts, and an audit trail under a local AgCensus folder. Projects are identified by country and reference year. The project folder defaults to `~/Documents/AgCensus` and can be changed in Settings.

**Source ingestion.** Add census PDFs and Excel workbooks via drag-and-drop or the native file picker in the Sources tab. Multiple files can be selected in a single operation. Each document is copied into the project's `sources/` directory and then indexed into a searchable evidence store (`evidence/pages/` and `evidence/tables/`). Excel workbooks are indexed sheet by sheet. The indexing step extracts text, page numbers, and table structure so the generators can retrieve relevant evidence at generation time.

**Import bundle.** An "Import bundle" button appears in the project list header. This feature — intended to allow a previously exported project bundle to be imported so that projects can be shared between machines or users — is planned but not yet implemented in this version. Clicking the button shows an advisory message.

**Metadata Review generation.** Generates all fifteen MR sections, each containing source-cited claims drawn from the indexed evidence. Sections are generated independently, so a single section can be regenerated without affecting others. In the MR review screen, individual claims can be edited inline, claims can be added or deleted, and sections can be approved. Approved sections are marked with a distinct badge and the approval is recorded in the audit log.

**Tables of Main Results generation.** Populates the twenty-three WCA 2020 sub-tables. Each cell in the populated output is linked to the source page or table from which the value was drawn. Cells can be inspected for their source citation, and validation flags (for example, when component rows do not sum to the stated total) are surfaced automatically. The TMR review screen shows each sub-table with its row–column grid and flags any cells with unverified or missing sources.

**Multi-provider model selection.** The application supports fourteen models across six providers, organised into three tiers. Budget tier (Tier 1) includes DeepSeek V4 Flash, Gemini 2.0 Flash, GPT-4o mini, Claude Haiku 4.5, and Azure GPT-4o mini. Mid-range tier (Tier 2) includes DeepSeek V4 Pro, Kimi K2.6, Kimi K2.6 Thinking, Gemini 2.5 Flash, and Claude Sonnet 4.6. Premium tier (Tier 3) includes GPT-4o, Gemini 2.5 Pro, Claude Opus 4.8, and Azure GPT-4o. Azure OpenAI models are available for FAO Microsoft 365 enterprise deployments and require an endpoint URL and deployment name in addition to an API key. The model selector in the MR and TMR review screens shows a cost estimate before generation begins.

**API key management.** API keys are stored in the application's local app store via the operating system, never written to project files or source control in plain text. Keys can be entered and tested from the Settings screen. Environment variables in a `.env` file at the project root take precedence in development.

**Audit log.** Every generation, edit, and approval is recorded with the model used, input and output token counts, estimated cost in USD, and a wall-clock timestamp. The audit log viewer (accessible from the project overview) shows events colour-coded by type and supports sorting newest-first or oldest-first.

**Export.** The Metadata Review can be exported to Markdown or to a Word document (`.docx`). The Tables of Main Results can be exported to Excel (`.xlsx`). Exported files are written to the `exports/` subdirectory of the country project folder.

## Supported languages

The application handles non-English census documents. Evidence scoring applies a numeric-density bonus that helps identify data-bearing pages regardless of script, and a non-English prompt instruction is inserted automatically when low-confidence or fallback pages are detected. Multilingual quality varies by model: Gemini, Claude, and Kimi tend to handle non-English documents better than models with primarily English training data.

## Installation

Three distribution formats are available for Windows.

**MSI installer** (`Ag Census MR TMR Compiler_1.0.0_x64_en-US.msi`). Requires administrator rights and installs to Program Files. Recommended for permanent workstation installations managed by IT. Windows Smart App Control may block the installer until the application is code-signed with a trusted certificate; this will be addressed in a future release.

**NSIS no-admin installer** (`Ag Census MR TMR Compiler_1.0.0_x64-setup.exe`). Installs to the user's AppData folder without requiring administrator rights. This is the recommended option for office laptops where IT policies prevent use of the MSI. If Windows SmartScreen appears, click "More info" and then "Run anyway".

**Portable ZIP** (`AgCensus-MR-TMR-Compiler-portable-win.zip`). No installation required. Unzip to any location — a USB drive, the Desktop, or a network share — and launch `agcensus-compiler.exe` directly. A bundled Node.js runtime is included in the ZIP, so nothing else needs to be installed on the host machine. Nothing is written outside the extracted folder.

See `PILOT-SETUP.md` for the detailed setup and first-use guide.

## Getting started

1. Install the application using the format most appropriate for your machine (see above), or unzip the portable archive.
2. Open the application and click the gear icon (bottom-left) to open Settings. Add at least one API key and click Test to verify the connection.
3. Click `+ New project`, fill in the country name, ISO3 code, reference year, and methodology type, and click "Create project".
4. Click the new project card to open the project overview, then select the Sources tab. Drag your census PDF or Excel files onto the drop zone, or click to browse. Confirm the document ID and language for each file and click "Add and index". Wait for the green confirmation before proceeding.
5. From the project overview, click "Open review" under Metadata Review Draft, then "Generate all sections". Repeat for the Tables of Main Results.
6. Review and approve each section and sub-table, editing any claims or cells as needed.
7. Export the Metadata Review (MD or DOCX) and the Tables of Main Results (XLSX) using the export buttons in the review screens.

See `PILOT-SETUP.md` for troubleshooting and a step-by-step walkthrough.

## Building from source

**Prerequisites:**

- Node.js LTS (18 or later)
- Rust toolchain (install via [rustup.rs](https://rustup.rs))
- On Windows: Visual Studio Build Tools 2022 with the "Desktop development with C++" workload and the Windows SDK

**Development:**

```
npm install
npm run tauri:dev
```

**Production build:**

```
npm run build:all
npm run build:portable
```

If the build is blocked by Windows Defender Application Control, set the `CARGO_TARGET_DIR` environment variable to a path outside the OneDrive or network-synced folder before running `npm run build:all`.

## Technology

The application is built with Tauri 2.x (Rust shell), React, TypeScript, and Vite. Project data is stored as plain JSON and Markdown files on disk — no database or migration layer. LLM access uses OpenAI-compatible endpoints for DeepSeek, Kimi, Google Gemini, and OpenAI, and the Anthropic SDK for Claude models. Sidecar Node.js scripts, compiled with esbuild, handle evidence ingestion, MR and TMR generation, and export. API keys are stored via the Tauri plugin store, backed by the operating system keychain.

## Author and licence

Author: D. Bako. The methodology follows the FAO World Programme for the Census of Agriculture (WCA) 2020.

Licence: [to be specified]
