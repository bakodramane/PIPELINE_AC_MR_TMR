## Provider notes (discovered Session 2)

DeepSeek V4-Flash: must send thinking: { type: 'disabled' } on every
request. Default is thinking mode; content is empty without this flag.

Kimi K2.6: temperature must be exactly 1.0. API returns 400 for any
other value. Both thinking and non-thinking modes enforce this.

DeepSeek V4-Pro promo pricing ($0.435/$0.87 per M tokens) expires
2026-05-31. Update pricing.json after that date.

## Session 3 notes

validate.ts returns typed ValidationIssue[] with severity error | warning.
Run validateProject(dir) after any generation to catch schema drift early.

EvidenceIndex entries carry keywords[] for relevance matching —
added by agent, not in DESIGN.md §4 explicitly. Kept: it is the
right hook for Session 5's evidence retrieval step.

## Session 4 verified against real Nepal PDF

All 8 ingest tests pass on real data. Key findings:

PATH RESOLUTION IN TESTS: Claude Code runs in a git worktree with
its own references/ directory. Always search for the specific file
path (e.g. references/nepal-2021/sources/main-report.pdf), not just
the folder name. Use candidate paths walking up from __dirname.

BLANK PAGES: Census PDFs contain legitimate blank/image-only pages
(covers, back-matter). Expect ~10-20% blank pages in any real corpus.
Evidence retrieval (Session 5) must skip pages where text.length < 100
to avoid wasting context budget on empty pages.

PAKISTAN PDF: Place at references/pakistan-2024/sources/main-report.pdf
before Session 6. Same path resolution pattern applies.

