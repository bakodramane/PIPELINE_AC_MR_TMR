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

