#!/usr/bin/env bash
# Launch a corpus scan inside tmux with a live three-pane view.
#
#   eval/tmux-run.sh [corpus-dir] [session-name]
#   tmux attach -t pired
#
# Panes: the scan's own output, the ledger updating as pired records, and a
# results tally. Everything the run knows, visible while it happens — which is
# what was missing when a working run looked identical to a stalled one.
set -uo pipefail
CORPUS="${1:-/tmp/corpus-all}"
SESSION="${2:-pired}"
REPO=/home/mamgad/pired
LOG=/tmp/pired-scan-$(date +%H%M%S).log

tmux kill-session -t "$SESSION" 2>/dev/null

# Pane 0 — the scan itself.
tmux new-session -d -s "$SESSION" -n scan -x 200 -y 50 \
  "cd $REPO && node --experimental-strip-types eval/corpus/run.ts \
     --corpus $CORPUS --provider lmstudio --model qwen3.8-27b \
     --concurrency ${CONCURRENCY:-1} --timeout ${TIMEOUT:-14400000} 2>&1 | tee $LOG; \
   echo; echo '=== scan finished — press a key ==='; read -r"

# Pane 1 — the ledger, refreshed every 5s for the target currently under review.
tmux split-window -t "$SESSION:scan" -v -l 55% \
  "while true; do
     clear
     p=\$(pgrep -x pi 2>/dev/null | while read q; do case \"\$(readlink /proc/\$q/cwd 2>/dev/null)\" in /tmp/corpus*) echo \$q; break;; esac; done)
     if [ -n \"\$p\" ]; then
       t=\$(readlink /proc/\$p/cwd); t=\${t##*/}
       d=\$HOME/.pired/engagements/\$t
       echo \"── current target ────────────────────────────────\"
       echo \"  \$t\"
       echo \"  elapsed \$(ps -o etime= -p \$p | tr -d ' ')   cpu \$(ps -o time= -p \$p | tr -d ' ')\"
       echo
       for f in inventory hypotheses findings; do
         n=0; [ -f \"\$d/\$f.jsonl\" ] && n=\$(wc -l < \"\$d/\$f.jsonl\")
         printf '  %-12s %s\n' \"\$f\" \"\$n\"
       done
       echo \"  evidence     \$(ls \"\$d/evidence\" 2>/dev/null | wc -l)\"
       echo
       echo \"── latest records ────────────────────────────────\"
       tail -3 \"\$d/inventory.jsonl\" 2>/dev/null | python3 -c 'import sys,json;[print(\"  \"+ (json.loads(l).get(\"path\") or json.loads(l).get(\"value\") or json.loads(l).get(\"name\") or \"\")[:70]) for l in sys.stdin if l.strip()]' 2>/dev/null
       tail -2 \"\$d/findings.jsonl\" 2>/dev/null | python3 -c 'import sys,json;[print(\"  FINDING [\"+json.loads(l).get(\"severity\",\"?\")+\"] \"+json.loads(l).get(\"title\",\"\")[:60]) for l in sys.stdin if l.strip()]' 2>/dev/null
     else
       echo '  (no target running)'
     fi
     sleep 5
   done"

# Pane 2 — results as targets score.
tmux split-window -t "$SESSION:scan" -h -l 50% \
  "while true; do
     clear
     echo '── results ───────────────────────────────────────'
     grep -E 'recall |FAILED' $LOG 2>/dev/null | tail -20 || echo '  none yet'
     echo
     grep -E 'pooled' $LOG 2>/dev/null | tail -2
     sleep 10
   done"

tmux select-pane -t "$SESSION:scan.0"
echo "session '$SESSION' started · log $LOG"
echo "attach with:  tmux attach -t $SESSION"
