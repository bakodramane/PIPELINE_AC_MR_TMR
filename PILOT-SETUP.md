# AgCensus Compiler — Pilot Setup Guide

## What you need (one-time setup, ~10 minutes)

1. **Install Node.js** — go to nodejs.org, download the LTS version,
   run the installer, click Next through all steps, restart your computer.

2. **Start the app** — double-click `launch-agcensus.bat` in the project folder.
   The first launch takes 2–3 minutes (it is building the app).
   A window titled "AgCensus Compiler" will open.
   Subsequent launches take about 15 seconds.

## Adding your API key (one-time, ~2 minutes)

1. Click the ⚙ gear icon (bottom-left of the app).
2. Under DeepSeek, paste your API key and click Save, then Test.
   You should see "✓ OK" in green. If not, check the key and try again.
3. Click Back.

## Creating a country project (~2 minutes)

1. Click "+ New project" in the top-right.
2. Fill in: country name, ISO3 code (3 letters, e.g. ETH for Ethiopia),
   census name, reference year, methodology type.
3. Click "Create project". The project card appears on the home screen.

## Adding source documents (~1 minute per PDF)

1. Click your project card.
2. Click the "Sources" tab.
3. Drag your census PDF onto the upload zone, or click to browse.
4. Check the Document ID (change if needed) and Language, then click
   "Add and index". Wait for the green "Indexed successfully" message.
5. Repeat for each source document (main report, methodology, annexes).

## Generating the Metadata Review (~5–10 minutes)

1. Click "Open review" under Metadata Review Draft.
2. Click "Generate all sections".
3. Watch the progress bar — each section updates as it completes.
4. When finished, click any section to expand and read the generated text.

## Generating the Tables of Main Results (~10–20 minutes)

1. Click the "TMR sub-tables" tab.
2. Click "Generate all sub-tables".
3. When finished, click any sub-table to see the populated cells.

## Exporting results

- MR: click "Export MD" (top-right of MR screen) → saves a Markdown file
- TMR: click "Export XLSX" (top-right of TMR screen) → saves an Excel file
- Both files go to: Documents\AgCensus\<your-country>\exports\

## Changing the AI model

The dropdown at the top-left of the MR and TMR screens lets you choose
the AI model. DeepSeek V4 Flash is the default (cheapest, fastest).
For complex or non-English documents, try Kimi K2.6 or Claude Opus 4.7.

## Troubleshooting

**"Could not load projects"** — The Documents\AgCensus folder may not exist yet.
Create a project using "+ New project" and it will be created automatically.

**Sections generate as "empty"** — Your source PDFs may not be indexed yet.
Go to the Sources tab and add your PDFs before generating.

**The black window shows an error** — Send a screenshot to [Dramane's contact].

## Feedback

Please fill in PILOT-FEEDBACK.md after processing your country.
Your feedback shapes the next version of the tool.
