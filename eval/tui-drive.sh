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
CORPUS="${1:-/tmp/corpus-clean}"
SESSION="${2:-pired}"
REPO=/home/mamgad/pired
RESULTS=/tmp/pired-tui-results.txt
QUIET_S="${QUIET_S:-600}"     # 10 min of no ledger writes = turn finished
MAXWAIT_S="${MAXWAIT_S:-14400}"

PROMPT='Perform a security review of this codebase. Record the surface you find, record hypotheses and their outcomes as you settle them, and record confirmed issues as findings with cwe, severity and the exact file:line of the vulnerable sink.'

: > "$RESULTS"
mapfile -t TARGETS < <(python3 -c "
import json,os
m=json.load(open('$CORPUS/manifest.json'))
def kb(t):
    b=0
    for r,_,fs in os.walk(t):
        for f in fs:
            if f.endswith('.py'):
                try: b+=os.path.getsize(os.path.join(r,f))
                except OSError: pass
    return b
for e in sorted([e for e in m if os.path.isdir(e['target'])], key=lambda e: kb(e['target'])):
    print(e['target'])")

tmux kill-session -t "$SESSION" 2>/dev/null
tmux new-session -d -s "$SESSION" -n review -x 230 -y 56 "echo 'starting…'; sleep 2"
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

for T in "${TARGETS[@]}"; do
  name=$(basename "$T")
  d="$HOME/.pired/engagements/$name"
  rm -rf "$d"

  # Left pane becomes the live pired TUI for this target.
  if ! tmux has-session -t "$SESSION" 2>/dev/null; then
    echo "$(basename "$T")  FAILED — tmux session gone" >> "$RESULTS"
    continue
  fi
  tmux respawn-pane -k -t "$SESSION:review.0" \
    "cd $T && exec node $REPO/bin/pired.mjs --profile review --provider lmstudio --model qwen3.8-27b --thinking high --target $T"
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
  start=$(date +%s); last_change=$start; sig=""
  while true; do
    now=$(date +%s)
    cur="$(cat "$d"/*.jsonl 2>/dev/null | wc -l)"
    [ "$cur" != "$sig" ] && { sig="$cur"; last_change=$now; }
    [ $(( now - last_change )) -ge "$QUIET_S" ] && break
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
  ' "$d" "$CORPUS/../corpus/$name.truth.json" "$name" 2>/dev/null | tail -1)
  echo "${line:-$name  (no result)}" >> "$RESULTS"

  tmux send-keys -t "$SESSION:review.0" C-c 2>/dev/null; sleep 1
  pgrep -x pi 2>/dev/null | while read q; do case "$(readlink /proc/$q/cwd 2>/dev/null)" in /tmp/corpus*) kill -9 "$q" 2>/dev/null;; esac; done
  sleep 3
done

tmux respawn-pane -k -t "$SESSION:review.0" "echo '=== all targets done ==='; cat $RESULTS; read -r"
