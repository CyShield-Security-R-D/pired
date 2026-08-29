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
prev_cpu=""; prev_line=""; prev_led=""; stall=0; beat=0

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
    # CPU is a poor liveness signal here and the threshold was badly wrong.
    # A process waiting on an HTTP response burns no CPU, so on a deliberately
    # slow inference server "no CPU for five minutes" is the normal case, not a
    # hang — that threshold produced false HUNG verdicts on runs that were
    # working fine, and one of them was killed on the strength of it.
    # Thirty minutes without a single ledger write is worth mentioning; less
    # than that is just the server being cheap.
    [ $stall -eq 30 ] && echo "QUIET — $tgt: no ledger write for ~30min (cpu=${cpu}s) $led — may be normal on a slow server"
  else
    [ $stall -ge 30 ] && echo "RESUMED — $tgt writing again"
    stall=0
    # CPU ticks every poll, so reporting on it alone is a heartbeat once a
    # minute — noise. Speak when the ledger moves (real work landed) or every
    # tenth poll, so a long quiet stretch still confirms liveness.
    beat=$((beat+1))
    if [ "$led" != "${prev_led:-}" ] || [ $((beat % 10)) -eq 0 ]; then
      echo "WORKING $tgt cpu=${cpu}s $led  [$results/15 done]"
    fi
    prev_led="$led"
  fi
  prev_cpu=$cpu
  sleep 60
done
