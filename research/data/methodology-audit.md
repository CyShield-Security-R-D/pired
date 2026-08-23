# Methodology audit — quick reference

Scope-normalized metrics (out-of-labeled-scope frontend findings excluded; ground
truth is backend-only). Official numbers are in 03-results.md; these are the caveat.

| arm | findings | frontend (all FP) | recall | precision (raw→norm) | F1 (raw→norm) |
|-----|:--:|:--:|:--:|:--:|:--:|
| pired + qwen3.8-27b | 62 | 7 | 0.736 | 0.629 → 0.709 | 0.678 → 0.722 |
| codex / gpt-5.6-sol | 45 | 0 | 0.679 | 0.800 → 0.800 | 0.735 → 0.735 |
| vanilla pi + qwen   | 55 | 7 | 0.585 | 0.564 → 0.646 | 0.574 → 0.614 |

Key point: the pired-vs-codex F1 gap shrinks from 0.057 (official) to 0.013 (normalized).
See 04-findings-and-conclusions.md §7b for the full both-directions audit.
