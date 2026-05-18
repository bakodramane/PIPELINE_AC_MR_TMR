# Developer brief — AgCensus Compiler

## The role in one sentence

I need a developer to build a desktop application that helps FAO statisticians produce two structured documents (a Metadata Review and a Tables of Main Results spreadsheet) from countries' agricultural census source PDFs, using LLM APIs.

## About the project

The FAO World Programme for the Census of Agriculture supports more than 125 countries in conducting national agricultural censuses on a ten-year cycle. For each country that publishes census results, FAO methodologists currently produce two standardised documents by hand: a fifteen-section Metadata Review describing how the census was conducted, and a Tables of Main Results spreadsheet of twenty-six WCA-standardised sub-tables. The work is slow and error-prone. We want to build a tool that reduces compilation time from days to hours per country while preserving full source traceability.

The tool is not a one-click generator. It produces drafts that a methodologist reviews, edits, and approves, with every claim and every figure traceable to a specific page or table in a specific source document. Quality and auditability matter more than speed.

## What you'll build

A cross-platform desktop application (macOS, Windows, Linux) that:
- Imports country census documents (PDFs, Excel files, NSO website snapshots)
- Parses and indexes them into a structured evidence store
- Generates a draft Metadata Review and a populated TMR Excel workbook using LLM APIs (DeepSeek V4, Moonshot Kimi K2.6)
- Presents a review interface where statisticians edit and approve drafts section by section, cell by cell
- Tracks every action in an audit log
- Includes an evaluation harness that compares generated output against certified gold-standard countries

The app is local-only — no cloud, no shared backend. Country projects live on the staff member's laptop as a directory of files. Collaboration happens via zipped project bundles.

## Stack

- **Tauri 2.x** (Rust shell, web UI)
- **React + TypeScript + Vite**
- **Tailwind CSS**, shadcn-style components
- **DeepSeek and Kimi APIs** via OpenAI-compatible endpoints
- **Local file storage** (JSON, Markdown, XLSX) — no database

You will receive a complete `DESIGN.md` covering architecture, the country project schema, the provider abstraction, the MR and TMR generators, the evaluation harness, the UI structure, error handling, and a step-by-step build order. The design is unusually well-specified for a project at this stage — your job is execution, not redesign.

## Scope and timeline

Twelve weeks of focused work for v1. The phases:

- **Weeks 1–4 — Foundation.** Tauri shell, provider abstraction, country project schema, PDF parsing, MR generator working end-to-end for one section against Nepal and Pakistan source corpora.
- **Weeks 5–8 — Generators.** Complete MR generator (all fifteen sections), TMR generator (all twenty-six sub-tables), issues queue, source review UI, basic audit log.
- **Weeks 9–12 — Harness and polish.** Evaluation harness, prompt library, import/export bundles, cross-platform signed installers, real-world testing on five countries.

There are checkpoints at the end of weeks 4, 8, and 12 with explicit go/no-go criteria.

## Working style

You will use **Claude Code** as your primary development tool, with the API costs covered by FAO. The `DESIGN.md` is structured to be pasted into Claude Code sessions; the agent will scaffold, write, and iterate on the code. Your job is to direct the agent, review every diff before accepting it, make the judgement calls Claude Code cannot make (PDF edge cases, cross-platform issues, security review), and own the integration of the pieces.

This is not a vibe-coding role. You need real software engineering experience and the judgement to know when the agent is wrong. The candidates we are looking for have shipped Tauri or Electron apps before, are comfortable with TypeScript end-to-end, and can read a generated diff and spot a quiet correctness bug.

Communication is weekly: a short written update Mondays, a 30-minute video call Thursdays, ad-hoc Slack between. You manage your own schedule.

## Required experience

- Production experience with Tauri or Electron (must have shipped at least one cross-platform desktop app)
- Strong TypeScript and React
- Familiarity with PDF parsing in a Node environment (pdf-parse, pdfjs, or similar) and OCR fallbacks (Tesseract)
- Comfortable with OpenAI-style chat completion APIs and streaming responses
- Has used Claude Code, Cursor, or equivalent agentic coding tools on a real project
- Reads and writes good written English; will produce architecture notes, weekly updates, and inline documentation

## Bonus

- Experience with statistical or research-tool software
- Background in working with multi-language source documents (the corpora include French, Spanish, Portuguese, Arabic, and others)
- Has signed and notarized macOS apps before; has dealt with Windows code signing

## Deliverables

By end of week 12:
- Working v1 of AgCensus Compiler, signed installers for macOS, Windows, Linux
- Source code in a Git repository owned by FAO, with a clear `README.md` and architecture documentation
- End-to-end documented generation of MR and TMR for at least five countries (Nepal, Pakistan, and three others to be agreed)
- Evaluation harness operational with at least two certified gold-standard countries
- A handover document covering deployment, prompt update workflow, and known issues / planned v2 work
- A two-hour walkthrough session with two FAO methodologists who will pilot the app

## Budget

USD 35,000 to USD 60,000 fixed-price for v1 scope, depending on your rate and location. Paid in three instalments tied to the week 4, 8, and 12 checkpoints. API costs for development (Anthropic for Claude Code, DeepSeek and Kimi for testing) reimbursed against receipts, expected to be under USD 500 total.

Out-of-scope work (additional features, v2 planning, post-pilot fixes beyond the four-week support window) is billed hourly at your standard rate.

## How to apply

Send the following to [hiring contact]:
1. A one-page note covering your experience with the items in "Required experience" above, with links to two production desktop apps you have built or contributed substantially to
2. Your hourly rate and your expected fixed-price for the v1 scope as described
3. A short note (no more than 300 words) on something in this brief you would push back on or flag as risky, given what you know about building this kind of tool

Item 3 is the most important part of the application. We are looking for someone who can engage critically with the design, not someone who agrees with everything to win the contract. If you think the schema is wrong, the timeline is unrealistic, or the choice of provider is misguided, say so.

We will respond within five business days. Shortlisted candidates will be invited to a 45-minute call.
