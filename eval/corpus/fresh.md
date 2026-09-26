# Fresh applications for delegation v6

Plan item 4.1 (`docs/delegation-v6-plan.md`). The v6 acceptance run is graded on applications pired
has never been graded, diagnosed or tuned on, drawn by a procedure fixed before the draw. The
procedure is `eval/corpus/select-fresh.ts`; its pure parts are tested in `select-fresh.test.ts`.
Everything it produced is in `eval/corpus/fresh/`.

**Pre-registration.** The script, its parameters, the seed, the pool and the exclusion list were
committed before `draw` was run. The results section below was added afterwards and changes nothing
above it.

## Why not the existing pool

`/home/mamgad/corpus` holds 46 CVEs in 15 repositories. All 15 are excluded under the rules below:
five are the official v5 targets, four are the held-out targets, and the other six (YOURLS, goshs,
cloudcmd, archivy, django-helpdesk, alerta) are named in `research/10` as members of the corpus pired
was built against. Excluding every repository any of pired's work touched leaves nothing there to
draw from.

So the pool is the one that corpus was itself selected from: OSV's GIT export, which `fetch-repos.ts`
and `research/10` already use because small web applications are rarely published as packages.

## Procedure

1. **Pool** (`select-fresh.ts pool`). Every `CVE-*` record in OSV's `GIT/all.zip` with at least one
   reference typed `FIX` to a `github.com/<owner>/<repo>/commit/<sha>` URL. Snapshot of
   2026-09-26 13:19:46 GMT, zip sha256 `2afa8f54…741adb`: 88,101 CVE records, 23,279 in the pool,
   6,642 repositories. The derived pool is committed as `fresh/pool.json` (sha256 of its
   advisories `4d50c3d4…a137e`) so the draw can be repeated after OSV has moved on. Only CVE
   records, because GSD, UVI and PYSEC mirror the same bugs; only `FIX`-typed references, because an
   untyped commit reference is often the release (research/10: bludit's three advisories all point
   at a version bump).
2. **Exclusions** (`select-fresh.ts exclusions` → `fresh/exclusions.json`). A repository is excluded
   whole if it appears in any of:
   - the official v5 manifest and the held-out manifest — ids, names and repositories only;
   - the old pool: `index.json`, every path name to depth 3 (run directories, results, target trees,
     work directories) and every top-level file (MATRIX.md, TOKENS.md, PLAN.md, every run log and
     script), matched on `owner/repo` or `owner_repo`;
   - every version, on every branch, of pired's `research/**`, `docs/**`, `eval/*.md`,
     `eval/corpus/*.ts` and every `*.md` — 492 blobs — matched on either slug or the bare repository
     name. Bare names over-exclude (`core`, `server`, `cli`, `framework`) and that is deliberate: when
     unsure, exclude;
   - the deliberately vulnerable applications checked out beside pired (DVBank/DVBLab, DVWA,
     WebGoat, juice-shop).

   805 repositories are excluded, 801 of them in the pool. Not scanned: this procedure's own outputs
   (they name the draw), `eval/heldout/` beyond the manifest's names, and `eval/artifacts/`.
3. **Metadata filters**, over the whole pool, in this order: fix commits in one repository; exactly
   one fix commit (with two, which parent is the vulnerable version is a choice, and a backport makes
   it the wrong one); a publication date; not excluded; then the publication cutoff (step 5).
4. **The walk** (`select-fresh.ts draw`). Candidate repositories are sorted, then shuffled with
   mulberry32 from the seed. Each is tried on up to 3 of its advisories, in a second order seeded from
   the seed and the repository's name. An advisory is eligible when, at the fix commit's first
   parent:
   - **source obtainable** — the fix and its parent fetch from GitHub;
   - **size** — 3,650 to 38,977 lines of source as `lib.ts walk()` counts them, the range of the five
     official targets; a tree with more than 3,000 source files is rejected before its blobs are
     fetched (it would need under 13 lines per file to fit);
   - **served application** — a route registration in at least one source file and at least two of
     templates, migrations, a server entry. Not `fetch-apps.ts`'s rule: that wants three route
     files and rejects three of the five official targets (filebrowser, whoogle-search and note-mark
     each keep their routes in one file). The five official trees all pass this one;
   - **language** — the language with the most lines, over code files of any language, is one the
     pinned scorer reads (`eval/dvbank/score.ts`: py, js/ts, go, rb, php, java, cs, rs, kt, scala);
   - **labellable fix** — the fix changes at least one code line, not a comment or a blank, in a
     source file the scorer reads, outside tests, docs, examples, vendored and minified code;
   - **not diffuse** — at most 12 labels (below): more is a refactor or a release diff, and which of
     its edits is the vulnerability cannot be told without judgement;
   - **labels survive leak stripping** — no labelled file would be deleted by `stripLeakage`.

   The first eligible advisory stands for its repository. It is admitted unless its language already
   holds 6 of the 12 places, so no language exceeds half the draw. Once 12 are drawn the walk
   continues for **2 clean-code controls**: a later eligible repository whose *fixed* tree is
   reviewed, admitted only if every other advisory of that project in the pool is fixed in that tree
   too (its fix is an ancestor), and if the fixed tree passes the size, application and language
   rules. A control's truth is empty; its fixed regions are recorded, so a claim there can be read as
   a false alarm on fixed code.
5. **Publication cutoff.** The walk runs first with advisories published on or after 2026-01-01.
   The cutoff is kept only if the eligible repositories it leaves — the walk's yield at its Wilson 95%
   lower bound times the candidate repositories — are at least three times the draw (42), and the
   walk did not run out. Otherwise the draw is the walk without the cutoff. Both are this procedure,
   not a re-draw.
6. **Truth** (`select-fresh.ts truth`). Labels from each drawn target's fix diff on the vulnerable
   tree, plus every other advisory of the same project still open in that tree, by the three rules of
   `multikey.ts`: its fix descends from the reviewed tree, the labelled lines are unchanged between
   the two (`mapRangeBack`), and they translate to the reviewed tree's numbering. Anything that fails
   a rule is dropped and listed in `fresh/labels.json`, never guessed.

Parameters: seed **20260926** (the date the procedure was committed), N = 12 (`--n`; the script
takes any N and the v6 power analysis sets the final count), 2 controls, 3 tries per repository,
6 per language.

### One implementation change after pre-registration

The draw was started at `5cac587` and stopped by hand after 102 repositories, before it had written
anything, because a full checkout was downloading files no rule reads — one project's card images
held a single checkout for over eleven minutes. Every rule reads a path or a code file, so the walk
now takes paths from `git ls-tree` and checks out code only. The rules did not change and
`RULES_VERSION` did not move. `select-fresh.ts recheck` re-evaluated a seeded sample of 40 cached
verdicts from scratch with the new code — the one eligible verdict and 39 ineligible ones across
five filters — and all 40 came back identical, detail strings included. The draw then resumed from
the verdict cache; the walk's decisions depend only on those verdicts.

## Label hygiene

- **Width.** A label spans at most 31 lines. Hunks of one file merge when at most 6 lines apart and
  the merged label still fits; a run of hunks wider than 31 lines is split at hunk boundaries; a
  single hunk wider than 31 lines is capped to its first 31 lines, and its real span is kept in
  `labels.json`. Before this rule `refineKey` collapsed a file's hunks into one range: 7 of the 24
  official labels spanned more than 31 lines and the widest 501 (research/12). Six lines is two ±3
  windows — labels any closer would let one claim be graded as two finds.
- **Pure insertions** sit at the line they were inserted after, as `keyFromPatch` places them.
- **Class.** Within a target every label carries a class or none does. When every contributing
  advisory has a CWE, each label carries its advisory's first; otherwise no label carries one. A
  classless label beside a classed one cannot be matched by any claim that names a CWE
  (research/12, *Scoring sensitivity*). NVD's placeholders are not classes.
- **Diffuse fixes.** An advisory with more than 12 labels is ineligible to be drawn and, as another
  open advisory, contributes no labels.
- **Title.** Every label's title is its advisory id, so no write-up is copied into the key.

## Nothing is re-drawn

The draw is final once `fresh/selection.json` is written. `draw` refuses to overwrite it. A re-draw
for any reason — a target that cannot be built, a changed rule — is run with `--variant
--variant-reason "<why>"`, which appends it under `variants` beside the original; the original is
what the pre-registration refers to. A target is never swapped out after its results are seen.

The drawn targets stop being fresh the moment they are used. Their names appear only under
`eval/corpus/fresh*`, which the exclusion scan skips for this draw; a later corpus built by this
procedure should scan them.

## Reproduce

```sh
curl -sS -D headers.txt -o GIT-all.zip https://osv-vulnerabilities.storage.googleapis.com/GIT/all.zip
node --experimental-strip-types eval/corpus/select-fresh.ts pool --zip GIT-all.zip --headers headers.txt
node --experimental-strip-types eval/corpus/select-fresh.ts exclusions
node --experimental-strip-types eval/corpus/select-fresh.ts draw --seed 20260926 --work /tmp/pired-fresh-work
node --experimental-strip-types eval/corpus/select-fresh.ts truth --work /tmp/pired-fresh-work
node --experimental-strip-types eval/corpus/select-fresh.ts materialise --work /tmp/pired-fresh-work --out <corpus>
```

The committed `pool.json` and `exclusions.json` are the inputs of record; a new OSV snapshot makes a
different pool, and so a different draw. `materialise` writes `<corpus>/<name>.pristine`, the reviewed
commit as a plain tree with history and release notes stripped under every credited advisory's ids,
which is what the runner copies from. The manifests use the official `PLACEHOLDER/corpus` paths.

## Results

*Added after the draw (`63fe54a`) and the truth step. Nothing above this heading was changed by them.*

### Counts at each filter

| filter (whole pool) | advisories | repositories |
|---|---:|---:|
| pool: CVE record with a FIX-typed GitHub commit | 23,279 | 6,642 |
| fix commits in one repository | 23,088 | 6,479 |
| exactly one fix commit | 20,178 | 6,086 |
| publication date recorded | 20,178 | 6,086 |
| repository not excluded | 16,115 | 5,342 |
| published on or after 2026-01-01 | 6,387 | 2,107 |

The walk examined 345 of the 2,107 candidate repositories, trying 571 advisories. Advisories that
failed, by the first rule they failed:

| rule | failed |
|---|---:|
| source obtainable at the parent commit | 1 |
| size within the official range | 459 |
| served application | 83 |
| language in the scorer's list | 2 |
| labellable fix | 1 |
| fix not diffuse | 9 |
| labels survive leak stripping | 0 |

16 repositories were eligible: 12 admitted, 2 skipped because JavaScript/TypeScript already held 6
places, 2 admitted as controls, both on their first candidate. Size is the filter that matters: the
pool is dominated by projects far larger (or smaller) than the official targets.

**Date rule:** 16 eligible of 345 examined, Wilson 95% lower bound 2.87%, times 2,107 candidates
gives an estimated 60 eligible repositories against the 42 required. The cutoff held, so every
drawn advisory was published in 2026 (January 1, February 1, April 1, May 2, June 1, July 2, August
1, September 3; controls March and September). All 6,387 candidates after the cutoff are from 2026.

### Drawn targets

| name | repository | advisory | language | CWE | published | loc | labels | advisories | classed |
|---|---|---|---|---|---|---:|---:|---:|---|
| Quenary_tugtainer-f4dh8w | Quenary/tugtainer | CVE-2026-23846 | Python | CWE-598 | 2026-01-19 | 10,054 | 2 | 1 | yes |
| wooey_Wooey-rzhxdt | wooey/Wooey | CVE-2026-7142 | Python | CWE-266, CWE-285 | 2026-04-27 | 7,642 | 1 | 1 | yes |
| go-shiori_shiori-f6jaq5 | go-shiori/shiori | CVE-2026-61463 | JavaScript/TypeScript | CWE-269 | 2026-07-13 | 30,565 | 1 | 1 | yes |
| geopython_pygeoapi-f5gbrd | geopython/pygeoapi | CVE-2026-42352 | Python | CWE-918 | 2026-05-08 | 32,155 | 9 | 1 | yes |
| juice-shop_multi-juicer-f5k72n | juice-shop/multi-juicer | CVE-2026-48518 | JavaScript/TypeScript | CWE-352 | 2026-06-15 | 13,572 | 4 | 1 | yes |
| argos-ci_argos-javascript-f64pqe | argos-ci/argos-javascript | CVE-2026-59960 | JavaScript/TypeScript | CWE-78 | 2026-09-14 | 13,166 | 5 | 1 | yes |
| vmDeshpande_ai-agent-automation-f61fpx | vmDeshpande/ai-agent-automation | CVE-2026-54519 | JavaScript/TypeScript | CWE-862 | 2026-09-17 | 23,644 | 15 | 2 | yes |
| hyperledger_fabric-ca-f60tki | hyperledger/fabric-ca | CVE-2026-53658 | Go | CWE-90 | 2026-09-15 | 35,397 | 5 | 1 | yes |
| hitarth-gg_zenshin-f4zpfi | hitarth-gg/zenshin | CVE-2026-37281 | JavaScript/TypeScript | — | 2026-05-19 | 19,411 | 9 | 1 | no |
| feathersjs_feathers-f4fw4b | feathersjs/feathers | CVE-2026-27191 | JavaScript/TypeScript | CWE-601 | 2026-02-21 | 15,246 | 4 | 2 | yes |
| zhenorzz_goploy-f60sto | zhenorzz/goploy | CVE-2026-53553 | Go | CWE-200, CWE-22 | 2026-08-31 | 24,931 | 9 | 1 | yes |
| vastsa_FileCodeBox-f6l91z | vastsa/FileCodeBox | CVE-2026-64619 | Python | CWE-348 | 2026-07-20 | 5,899 | 9 | 1 | yes |

Languages: JavaScript/TypeScript 6 (the cap), Python 4, Go 2. "loc" is `scope_loc` at the reviewed
commit; the scope is the whole tree, as for the official targets.

**Clean-code controls** (fixed tree reviewed, empty truth, fixed regions in `controls.json`):

| name | repository | advisory | language | CWE | published | loc | fixed regions |
|---|---|---|---|---|---|---:|---:|
| mesop-dev_mesop-f87yds | mesop-dev/mesop | CVE-2026-93421 | Python | CWE-117, CWE-150 | 2026-09-23 | 28,801 | 2 |
| toxicbishop_DSA-with-tsx-f4gmrs | toxicbishop/DSA-with-tsx | CVE-2026-28678 | JavaScript/TypeScript | CWE-311, CWE-522 | 2026-03-07 | 10,060 | 7 |

### Truth

Derived for all 12 targets by rule, with no per-target judgement: **73 labels** (the official five
carry 24). Every label is 31 lines or fewer — the widest is 20, the median 1 — and none needed
capping; a structural check found every label inside its file at the reviewed commit. 11 targets are
classed; `zenshin` is classless because its advisory has no CWE. Two targets gained labels from a
second advisory still open in the reviewed tree (`ai-agent-automation`, `feathers`), and `feathers`
shares its fix commit with two further advisories. One open advisory of `FileCodeBox` was dropped:
its fix yields 18 labels (diffuse), 4 of which had also changed since the reviewed tree. Building
all 14 trees with `materialise` stripped 0 to 28 leak files per tree and lost no labelled file.

After the draw, one line of the truth step was corrected to match the pre-registered text: the
12-label bound on another open advisory now counts what its fix yields, not what survives mapping.
Rerun, the truth files are byte-identical; only the reason recorded in `labels.json` changed.

## Limitations

- **What the application rule admitted.** Read after the draw: `feathers` and the control `mesop`
  are frameworks for building web applications rather than applications deployed as they are, and
  `shiori`, a Go application, counts as JavaScript/TypeScript because its frontend has more lines.
  The heuristic admits them and the no-re-draw rule keeps them. A stricter rule would be a variant,
  logged beside this draw.
- **Training data.** Publication after a model's training cutoff makes it less likely the fix was
  seen, and none of the three v6 models publishes its cutoff. The date rule reduces the risk; it does
  not remove it. The network seal stops retrieval over the wire, not from weights.
- **Pool bias.** A project enters only by having a CVE whose record types a GitHub commit as its fix.
  That favours projects popular enough to be assigned CVEs, hosted on GitHub, and whose maintainers
  or NVD analysts link the patch. The pool is therefore not a sample of web applications; it is a
  sample of disclosed, patched ones.
- **Known bugs only.** Labels are known advisories. Real but undisclosed issues count as false
  positives, and a control is clean only of the advisories the pool knows about.
- **Heuristics.** The application rule, the comment test and the language count are heuristics that
  fail closed; the application rule was calibrated on the five official trees.
- **Patch-derived keys.** A label marks where the maintainer changed code, which is where the bug is
  in most fixes and beside it in some (a missing check is inserted where it was missing).
