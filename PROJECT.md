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