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

## Limitations

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
