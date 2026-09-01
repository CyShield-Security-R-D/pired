# 10 · The small-application corpus

*September 2026 — in progress, paused after 2 of 46 targets*

## Why this exists

`research/07` measured the harness against real library CVEs and found 2/8
against codex's 4/8, contradicting DVBank where the same build scored 0.736
against codex's 0.679. `research/08` diagnosed the contradiction as an ontology
mismatch — `host/service/endpoint/param/tech` has no purchase on a parsing
library — and chose to change the target class rather than extend the harness.

That decision produced an application corpus of 20 targets. This is the sequel,
and it exists because those 20 targets were the wrong *size*:

| | files | lines |
|---|---:|---:|
| DVBank (the reference) | 18 | 2,670 |
| smallest of the 20 | 714 | 45,786 |
| largest | 1,200 | 194,065 |

Thirteen of the twenty had to be rescoped to fit a context window, and exactly
one ever scored.

## What was wrong with the selector

Rebuilding the entire seed list under a size gate admitted **nothing**: 29
rejected for size, 8 for not being applications, 0 built. apache-airflow
measures 743,858 lines; mlflow 1,115,318; n8n 1,666,158.

The seed list is 85 package names somebody typed, and every name a person thinks
of is a famous project. Famous projects are enormous. No amount of filtering
harder fixes a selector that can only find what you already know.

Three defects were found and fixed in the pipeline itself:

**Advisories citing a pull request were silently discarded.** Candidate selection
required a reference matching a commit URL, and most GHSA entries cite the PR
instead. Measured across 61 seed packages since 2024: 1,185 advisories reachable
before, **241 more** after — +20%. apache-airflow alone went from 25 to 135.

**Untyped commit references were treated as fixes.** A commit URL can appear
under any reference type. Across the OSV bulk exports, 50,718 advisories carry a
git-range `fixed` event but only 26,776 carry a reference explicitly typed FIX,
and the difference is largely *release* commits. bludit's CVE-2026-25099/25100/
25101 all point at "chore: bump version" commits touching 30 files, one of them
+25,392 lines because it re-vendors tinymce. As an answer key that is not noisy
but **wrong** — the reviewer is scored against a diff containing no
vulnerability, and every miss is the benchmark's fault.

**Package ecosystems reach a third of the candidates.** 4,104 repositories are
reachable through PyPI/npm/Go/Packagist/Maven; 9,804 through OSV's GIT feed;
**6,776 only through GIT**. Small web applications are usually not published as
packages. `fetch-repos.ts` selects by repository instead.

## The size gate

Admission now tests size, after classification and **before the answer key is
computed**, measured over the whole application at the vulnerable commit.

Both placements are deliberate. If admission consulted the key — or the
key-derived scope — then whether a project is a valid target would depend on
where its bug happens to be. And HEAD is not a proxy for the vulnerable tree:
froxlor measures 1,322 lines on its default branch and 72,035 at its advisory.

This replaces `rescope.ts` in the path rather than complementing it. Rescoping
derives the surviving subtree from the answer key, which hands the reviewer "the
bug is somewhere in these 700 files" — a different, easier question wearing the
same name — and drops the entry point and auth layer that reachability reasoning
depends on.

## The corpus

**46 targets · 88 ground-truth entries · 15 projects**, built at a 40,000-line
cap.

| | |
|---|---|
| size | min 3,650 · median 13,042 · max 39,013 lines |
| post-cutoff (2025-06+) | 21 of 46 |
| severity | 9 critical · 11 high · 17 moderate · 1 low |
| classes | XSS ×9, authz ×6, access control ×5, traversal ×5, cmd injection ×4, SSRF ×3, upload ×2, redirect ×2, info leak ×2 |
| languages | Go, Python, PHP, Ruby, TypeScript |

filebrowser, LinkAce, whoogle-search, publify, goshs, note-mark, filegator,
CasaOS, fat_free_crm, archivy, django-helpdesk, alerta, YOURLS, cloudcmd,
taguette.

Every target records its advisory's publication date, CWE and severity, so
scoring can be split pre/post model cutoff. The network seal stops retrieval
over the wire, not retrieval from weights.

**Contamination controls, verified rather than assumed:** `.git` is stripped
(confirmed absent from built targets); changelogs, security docs and release
notes are stripped; outbound HTTP is blackholed except the model endpoint
(tested — both `curl` and `urllib` fail under the runner's environment).

## Results so far — 2 of 46, both filebrowser

Paused deliberately after two targets. The reason is below.

| target | surface | hypotheses | findings | graded | recall |
|---|---:|---:|---:|---:|---:|
| CVE-2025-52903 | 133 | 1,499 (61 confirmed, **1,438 refuted**) | 27 | 0 | 0.00 |
| CVE-2026-29188 | 18 | 49 (11 confirmed, 38 refuted) | 4 | 0 | 0.00 |

Both hit the 30-minute ceiling and were killed. Both scored zero.

### The good news, and it is significant

**1,438 refutations.** The coverage mechanism — classes ruled out and recorded,
the half of an engagement a findings list cannot express — engaged properly on
real code for the first time. Across nine demo takes on DVBank earlier the same
day, the total number of refutations ever recorded was **four**.

### Why the score is zero, and it is two different reasons

**Mechanically: findings carry no line numbers.** Of 27 findings, zero have a
`file:line` target — they read `share.go`, `http/share.go`, `None`. The grader
locates a finding by extracting `file:line`, so all 27 were dropped before
scoring began. **A correct find would also have scored zero.** This must be
fixed before any further run: until it is, every target scores zero regardless
of what the agent finds.

**Substantively: it reviewed a different part of the application.** The key for
CVE-2025-52903 is a command-execution flaw across `http/commands.go`,
`runner/parser.go`, `runner/runner.go` and `users/users.go`. Across **620
hypotheses and 17 findings recorded at the moment of measurement — later 1,499
and 27 — not one mentions any of those four files.** The agent worked hard on
the sharing, auth and JWT surface and never opened the command runner.

That is not a harness defect. It is what a time-boxed review of an unfamiliar
12,000-line Go application produces, and it is the same result `research/07`
recorded at 2/8. Finding *a* bug is not finding *the* bug, and a maintainer-patch
answer key credits only the latter.

## To resume

```bash
node --experimental-strip-types eval/corpus/run.ts \
  --corpus /tmp/corpus-apps3 --provider lmstudio --model qwen3.8-27b \
  --concurrency 1 --timeout 1800000
```

Manifest: `/tmp/corpus-apps3/manifest.json` (46 targets, rebuildable via
`eval/corpus/fetch-repos.ts --repos … --index … --max-loc 40000`).

**Fix first, or the run is wasted:**

1. **Findings must carry `file:line`.** The prompt asks for "the exact file:line
   of the vulnerable sink" and the agent records the file alone. Either make the
   instruction unambiguous or have `record` refuse a finding whose target names a
   source file without a line — the same treatment an unknown checklist class now
   gets. Without this the corpus cannot score above zero.

2. **Decide what the benchmark asks.** With a maintainer-patch key, a broad
   review that finds four real bugs elsewhere scores identically to one that
   finds nothing. If the question is "can it find the disclosed bug", the search
   has to be pointed; if it is "can it review this application", the key is the
   wrong instrument and the scoring needs a second axis.

3. **Consider the time budget.** Both targets hit 30 minutes and were killed
   mid-review. 46 targets at that ceiling is ~23 hours. The ceiling is part of
   the experimental condition and is recorded per row, but if most targets hit it
   the corpus measures truncated reviews.

## Open

- **RaspAP returned 0 advisory records** under its slug, so its four
  command-injection CVEs — the best cmd-injection spread among the candidates —
  are not in the corpus.
- **16 advisories were skipped for lacking a FIX-typed commit**, including
  alerta's SQLi. The corpus has no SQLi as a result.
- The population is small by nature: roughly **99 repositories** exist in the
  whole OSV corpus in the 1k–30k line band with two or more fix-linked web-app
  advisories. Plan for a corpus in the low hundreds; "small" and "many
  advisories" pull against each other.
