#!/usr/bin/env bash
# Is the eval actually working, or merely alive?
#
# Process existence proves nothing: today a run sat for 21 minutes with 0:00 CPU
# because an orphaned pi from an earlier run held LM Studio's single inference
# slot. It looked identical to a long think. CPU time is the signal that
# distinguishes them — a working process accumulates it, a blocked one does not.
#
# Emits a line only when something changes, and says HUNG explicitly rather than
# leaving silence to be interpreted.
set -uo pipefail
LOG="${1:-/tmp/corpusrun2.log}"
prev_cpu=""; prev_line=""; stall=0

secs() { local t=$1 h m s; IFS=: read -r h m s <<<"$t"; [ -z "$s" ] && { s=$m; m=$h; h=0; }; echo $((10#$h*3600 + 10#$m*60 + 10#$s)); }

while true; do
  pid=$(pgrep -x pi 2>/dev/null | while read p; do
    case "$(readlink /proc/$p/cwd 2>/dev/null)" in /tmp/corpus*) echo "$p"; break;; esac
  done)

  results=$(grep -cE "recall |FAILED" "$LOG" 2>/dev/null | head -1); results=${results:-0}
  line=$(grep -E "recall |FAILED|pooled" "$LOG" 2>/dev/null | tail -1)

  if [ -n "${line:-}" ] && [ "$line" != "$prev_line" ]; then echo "RESULT $line"; prev_line="$line"; fi

  if [ -z "${pid:-}" ]; then
    if ! pgrep -f "experimental-strip-types eval/corpus" >/dev/null 2>&1; then
      echo "DONE — $results target(s) recorded"; exit 0
    fi
    sleep 30; continue
  fi

  tgt=$(readlink /proc/$pid/cwd 2>/dev/null); tgt=${tgt##*/}
  cpu=$(secs "$(ps -o time= -p "$pid" 2>/dev/null | tr -d ' ')")
  d=~/.pired/engagements/$tgt
  count() { [ -f "$1" ] && wc -l < "$1" | tr -d ' ' || echo 0; }
  led="inv=$(count "$d/inventory.jsonl") hyp=$(count "$d/hypotheses.jsonl") find=$(count "$d/findings.jsonl")"

  if [ "$cpu" = "${prev_cpu:-}" ]; then
    stall=$((stall+1))
    # 5 consecutive polls (~5 min) with no CPU movement is not thinking.
    [ $stall -eq 5 ] && echo "HUNG — $tgt: no CPU progress for ~5min (cpu=${cpu}s) $led"
  else
    [ $stall -ge 5 ] && echo "RECOVERED — $tgt resumed"
    stall=0
    echo "WORKING $tgt cpu=${cpu}s $led  [$results/15 done]"
  fi
  prev_cpu=$cpu
  sleep 60
done
