#!/usr/bin/env bash
# Drive the corpus through pired's real TUI, one target at a time, in tmux.
#
#   eval/tui-drive.sh [corpus-dir] [session]
#   tmux attach -t pired
#
# The headless runner is faster to script but shows nothing: you cannot watch a
# review happen. This runs the actual interactive TUI in the left pane — visible
# thinking, tool calls, the status line, coverage ticking up — and grades each
# target as it finishes, accumulating results in the right pane.
#
# Completion is detected from the workspace, not from the screen: when the ledger
# has stopped changing for QUIET_S the turn is done. Screen-scraping a spinner is
# brittle; the ledger is what the run is actually for.
set -uo pipefail
# Each target deletes ~/.pired/engagements/<target name>, and exit kills every `pi` process on the
# box. Refuse unless the caller has said this account is disposable.
if [ "${PIRED_EVAL_OK:-}" != "1" ]; then
  echo "eval/tui-drive.sh deletes ~/.pired/engagements/<target name> and kills every pi process." >&2
  echo "Run it as a throwaway user, in a container or VM, with PIRED_EVAL_OK=1." >&2
  exit 2
fi
# Killing this script must kill the agent it spawned. Without this the `pi`
# child outlives its parent, is reparented to systemd, and keeps writing to the
# engagement directory the next run is about to use.
cleanup() { tmux kill-session -t "${SESSION:-pired}" 2>/dev/null; pkill -x pi 2>/dev/null; }
trap cleanup EXIT INT TERM
CORPUS="${1:-/tmp/corpus-apps}"
SESSION="${2:-pired}"
REPO="$(cd "$(dirname "$0")/.." && pwd)"
RESULTS=/tmp/pired-tui-results.txt
QUIET_S="${QUIET_S:-600}"     # 10 min of no ledger writes = turn finished
GRACE_S="${GRACE_S:-3600}"    # a run that writes nothing at all in an hour never got going
MAXWAIT_S="${MAXWAIT_S:-14400}"
# The seal must exempt the model and nothing else. Derived from the provider's
# own baseUrl: a hardcoded host blackholes LM Studio on the LAN, and an
# unreachable model is indistinguishable from a wedged one.
MODEL_HOST=$(python3 -c "
import json,os,urllib.parse
p=os.path.expanduser('~/.pi/agent/models.json')
try: print(urllib.parse.urlparse(json.load(open(p))['providers']['lmstudio']['baseUrl']).hostname or '')
except Exception: print('')")

# Two clauses added after the gradio run, which spent an hour concluding
# "matches upstream Gradio 5.7.1 (no planted deviation found yet)" and recorded
# one inventory row, no hypotheses and no findings.
#
#  - The target IS upstream, at a real pre-fix commit. An agent that checks the
#    code against a remembered release and stops when they match cannot find the
#    bug, because the bug is in the release. The network seal stops retrieval
#    over the wire; it does nothing about retrieval from weights.
#  - Everything it learned went into notes.md. The ledger is what coverage is
#    computed from, so a review that never records is a void result no matter how
#    good the review was.
#
# Neither clause asserts that a vulnerability exists — that would be a hint.
PROMPT='Perform a security review of this codebase. This is production source from a real project, not a modified or seeded copy: do not compare it against any upstream version you recall, and do not treat "matches upstream" as evidence that code is safe — judge each sink on its own behaviour. Record the surface you find with record, record hypotheses and their outcomes as you settle them, and record confirmed issues as findings with cwe, severity and the exact file:line of the vulnerable sink. Notes are not a substitute for recording: anything not in the ledger does not count.'


: > "$RESULTS"
mapfile -t TARGETS < <(python3 -c "
import json,os
m=json.load(open('$CORPUS/manifest.json'))
# Order by the manifest's own scope_loc. The previous sort summed .py bytes,
# which ranks every Go, PHP, Java and JS target as size zero and runs the
# largest targets first — the opposite of what a smallest-first order is for.
def size(e): return e.get('scope_loc') or 0
for e in sorted([e for e in m if os.path.isdir(e['target'])], key=size):
    print(e['target'] + '\t' + e['truth'])")

tmux kill-session -t "$SESSION" 2>/dev/null
tmux new-session -d -s "$SESSION" -n review -x 230 -y 56 "echo 'starting…'; sleep 2"
tmux set-option -t "$SESSION" remain-on-exit on 2>/dev/null
# Right-hand pane: results, refreshed continuously.
# Layout, built in a deliberate order because the previous version produced a
# stack of full-width panes instead of a side rail: split the WINDOW horizontally
# first so the right column is full height, then split only the LEFT pane for
# results. Splitting the right column instead is what buried the panel at the
# bottom. Geometry is verified after the fact rather than assumed.
tmux split-window -h -t "$SESSION:review.0" -l "${RAIL_WIDTH:-62}" \
  "node --experimental-strip-types $REPO/bin/pired-state.mjs --watch --every 5 --width $(( ${RAIL_WIDTH:-62} - 2 )) --lines 40"

tmux split-window -v -t "$SESSION:review.0" -l 30% \
  "while true; do clear; echo '── results ──'; echo; cat $RESULTS 2>/dev/null; echo; echo \"[\$(grep -c . $RESULTS 2>/dev/null) / ${#TARGETS[@]} targets]\"; sleep 5; done"
# Optional third pane: live engagement state — scope, type, coverage, surface,
# hypotheses by outcome, findings by severity. Set PANEL=0 to omit it.
# The rail is pane 1 and is created above; PANEL=0 drops it.
if [ "${PANEL:-1}" = "0" ]; then tmux kill-pane -t "$SESSION:review.1" 2>/dev/null; fi

for ROW in "${TARGETS[@]}"; do
  T="${ROW%%	*}"; TRUTH="${ROW#*	}"
  name=$(basename "$T")
  d="$HOME/.pired/engagements/$name"
  rm -rf "$d"

  # Restore the target tree before every run, and refuse to start if another
  # agent is already inside it.
  #
  # The agent runs with cwd = the target, so its PoC scripts and evidence land in
  # the tree it is reviewing; left there, the next run reviews a different
  # codebase. run.ts has restored from a pristine snapshot since that surfaced —
  # this path never did, which made the two arms incomparable in a way nothing
  # reported.
  #
  # The guard exists because killing a parent pired.mjs does NOT kill its `pi`
  # child: three orphans survived that way, reparented to systemd, and one spent
  # ten minutes reviewing this very target alongside the live run, both writing
  # one engagement directory.
  for _ in $(seq 1 12); do pgrep -x pi >/dev/null 2>&1 || break; sleep 5; done
  if pgrep -x pi >/dev/null 2>&1; then
    echo "$name  FAILED — another pi still running after 60s; refusing to share a target" >> "$RESULTS"
    continue
  fi
  if [ -d "$T.pristine" ]; then
    rm -rf "$T" && cp -r "$T.pristine" "$T"
  else
    cp -r "$T" "$T.pristine"
  fi

  # Left pane becomes the live pired TUI for this target.
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "$(basename "$T")  FAILED — tmux session gone" >> "$RESULTS"
    continue
  fi
  tmux respawn-pane -k -t "$SESSION:review.0" \
    "cd $T && exec env HTTPS_PROXY=http://127.0.0.1:1 HTTP_PROXY=http://127.0.0.1:1 \
       https_proxy=http://127.0.0.1:1 http_proxy=http://127.0.0.1:1 \
       NO_PROXY=localhost,127.0.0.1,$MODEL_HOST no_proxy=localhost,127.0.0.1,$MODEL_HOST \
       node $REPO/bin/pired.mjs --profile review --provider lmstudio --model qwen3.8-27b --thinking high --target $T"
  sleep 12
  tmux send-keys -t "$SESSION:review.0" "$PROMPT" Enter

  # A result must never be written for a run that did not happen. The tmux
  # server died once mid-run and every tmux call failed silently, so nine
  # targets were graded 0/N without pired ever starting — indistinguishable, in
  # the results file, from a review that genuinely found nothing.
  started=0
  for _ in $(seq 1 12); do
    pgrep -x pi >/dev/null 2>&1 && { started=1; break; }
    sleep 5
  done
  if [ "$started" -eq 0 ]; then
    echo "$(basename "$T")  FAILED — pired never started" >> "$RESULTS"
    continue
  fi

  # Wait for the ledger to go quiet — that is the turn finishing.
  #
  # The quiet timer must not start until the ledger has been written at least
  # once. Started at launch, it expires while the agent is still reading and the
  # workspace gets graded empty: two targets scored 0/N here while pired was
  # visibly still working on them. A run that never writes anything is not a
  # review that found nothing, and must not be recorded as one.
  start=$(date +%s); last_change=""; sig=""
  while true; do
    now=$(date +%s)
    cur="$(cat "$d"/*.jsonl 2>/dev/null | wc -l)"
    if [ "$cur" != "$sig" ]; then sig="$cur"; last_change=$now; fi
    if [ -n "$last_change" ] && [ "$cur" != "0" ] && [ $(( now - last_change )) -ge "$QUIET_S" ]; then break; fi
    if [ $(( now - start )) -ge "$GRACE_S" ] && [ "$cur" = "0" ]; then
      echo "$(basename "$T")  FAILED — no ledger write in $((GRACE_S/60))m" >> "$RESULTS"
      pgrep -x pi 2>/dev/null | while read -r q; do case "$(readlink /proc/$q/cwd 2>/dev/null)" in /tmp/corpus*) kill -9 "$q" 2>/dev/null;; esac; done
      continue 2
    fi
    [ $(( now - start )) -ge "$MAXWAIT_S" ] && break
    pgrep -x pi >/dev/null 2>&1 || break
    sleep 20
  done

  # Grade against this target's key and record one line.
  line=$(cd "$REPO" && node --experimental-strip-types -e '
    import { fromLedger, dedupe, scoreFindings } from "./eval/dvbank/score.ts";
    import { readFileSync } from "node:fs";
    const [dir, truth, name] = process.argv.slice(1);
    const f = dedupe(await fromLedger(dir));
    const total = JSON.parse(readFileSync(truth, "utf8")).length;
    const s = await scoreFindings(f, "/tmp/tui-" + name + ".json", truth);
    const tp = s.true_positives ?? 0;
    console.log(`${name.padEnd(22)} found ${tp}/${total}  recall ${(s.recall ?? 0).toFixed(2)}  reported ${f.length}`);
  ' "$d" "$TRUTH" "$name" 2>/dev/null | tail -1)
  echo "${line:-$name  (no result)}" >> "$RESULTS"

  tmux send-keys -t "$SESSION:review.0" C-c 2>/dev/null; sleep 1
  pgrep -x pi 2>/dev/null | while read q; do case "$(readlink /proc/$q/cwd 2>/dev/null)" in /tmp/corpus*) kill -9 "$q" 2>/dev/null;; esac; done
  sleep 3
done

tmux respawn-pane -k -t "$SESSION:review.0" "echo '=== all targets done ==='; cat $RESULTS; read -r"
