# Live delegation assay

> **Superseded (2026-09-23, ADR-027).** These runs measured pired's native `pired_delegate` worker, which was removed when delegation moved to pi-subagents. The script that drove them (`eval/delegation.ts`) was deleted with it; the run directories under `eval/artifacts/delegation-*` are kept as history. The pi-subagents path is covered by `extensions/child.test.ts` (faux-model, end to end) and by the comparison harness's sealed delegation probe.

`node --experimental-strip-types eval/delegation.ts` runs one real pired session
against a temporary synthetic source tree. It checks early ledger recording,
child access to shared target-model data, a child finding written to the shared
ledger, event order, and bounded returned text. The fixture has no network
target. Luna is the default fast iteration model; repeat with local Qwen after a
change:

```sh
node --experimental-strip-types eval/delegation.ts
node --experimental-strip-types eval/delegation.ts --provider localqwen --model qwen3.8-27b
```

Use `--out <dir>` to choose an artifact directory, `--keep` to retain the
temporary fixture/workspace, `--timeout <ms>` to change the run deadline, and
`--max-return-chars <n>` to tighten the worker result bound. The run writes a
transcript and JSON report under `eval/artifacts/delegation-<stamp>/`; the report
includes the worker's artifact and the ledger state used for assertions. It
returns nonzero if any behavior check fails. No global pi extensions, skills, or
project context files are loaded; the runner explicitly loads only pired.

## Observed validation (2026-09-23)

These are one-fixture orchestration checks, not a detection benchmark or evidence
that review results improved. The parent and child shared one synthetic workspace;
the fixture contains no live service.

| Model | Result | Worker turns | Peak estimated input | Returned text |
|---|---:|---:|---:|---:|
| `openai-codex/gpt-6-luna` | 20/20 checks | completed, 12 | 8,104 tokens | 497 chars |
| `localqwen/qwen3.8-27b` | 19/20 checks | incomplete, 12 | 15,129 tokens | 384 chars |
| `openai-codex/gpt-6-luna`, latest | 19/20; evidence assertion false failure below | completed, 9 | 7,933 tokens | 631 chars |
| `zai/glm-5.3-flash`, latest | 20/20 checks | completed, 6 | 15,785 tokens | 1,732 chars |
| `localqwen/qwen3.8-27b`, latest | 20/20 checks | completed, 5 | 9,936 tokens | 1,015 chars |

The latest [Qwen run](artifacts/delegation-2026-09-23T13-12-14-890Z/report.json)
and [GLM run](artifacts/delegation-2026-09-23T13-14-43-172Z/report.json) completed
after workers were changed to inherit the parent's reasoning level and told to
hand back unresolved verification instead of repeatedly rewriting saved findings.
The earlier incomplete run remains below for comparison; these small fixtures
do not establish full-review quality or token savings.

The later Luna artifact at
[`delegation-2026-09-23T13-14-44-336Z`](artifacts/delegation-2026-09-23T13-14-44-336Z/report.json)
retains its raw 19/20 report. Manual inspection confirmed that the sole failure
was in the assay's evidence formatter check: the worker saved a numbered
`routes.js` listing whose line 2 exactly matches the fixture's SQL sink, while
the old assertion required the literal string `routes.js:2`. The check now
accepts that numbered listing only when it names `routes.js` and matches the
exact fixture source line. This was an assay false failure, not a worker finding
failure; the original report is unchanged.

Luna's [report](artifacts/delegation-2026-09-23T12-54-57-254Z/report.json) and
[event transcript](artifacts/delegation-2026-09-23T12-54-57-254Z/transcript.txt)
show the parent recording surface and a hypothesis before delegation, the child
retrieving a shared target-model sentinel through recall, incremental record
updates before the worker returned, resolvable source evidence, and parent recall
of the worker's unique finding. The sentinel check proves the worker can read
shared state; the parent may already see that model in its own context, so the
sentinel does not prove information transfer from child to parent. Qwen's
[report](artifacts/delegation-2026-09-23T12-56-35-108Z/report.json) and
[event transcript](artifacts/delegation-2026-09-23T12-56-35-108Z/transcript.txt)
show the same durable writes and parent recall, but the child repeatedly updated
the same finding ID and reached its 12-turn limit without producing its own final
summary. The failed `workerCompleted` assertion is retained; the parent identified
the incomplete status and completed normally.

The first Luna trace used an 8-turn limit and also ended incomplete after writing
records. That trace motivated a 12-turn fixture budget and remains available in
[its report](artifacts/delegation-2026-09-23T12-45-35-607Z/report.json). The live
runs also exposed two lifecycle issues: the headless runner needed to close pi's
stdin before startup, and the worker needed to release provider session resources
after each worker session. Workers now use the provider's simple stream interface
with refreshed registry authentication to preserve the parent's reasoning setting.
The repository check after those worker changes passed with 1,466 tests and 101
assay probes; benchmark instrumentation has additional tests of its own.
