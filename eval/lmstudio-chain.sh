#!/usr/bin/env bash
# Wait for LM Studio to come back, benchmark its concurrency, then scan the corpus.
#
# Written because the server wedged mid-session ("Context size has been exceeded"
# on a 3-token prompt, then no response at all) and everything downstream was
# blocked on a manual reload. This gates on health rather than assuming it, so
# the moment the model is reloaded the measurements run unattended — and it
# benchmarks BEFORE the scan, so concurrency is chosen from evidence instead of
# guessed the way it was the first time.
set -uo pipefail

HOST="${HOST:-http://192.168.1.15:1234}"
MODEL="${MODEL:-qwen3.8-27b}"
REPO=/home/mamgad/pired

probe() {  # tiny request; prints http code
  curl -s -m 90 -o /tmp/lmprobe.json -w '%{http_code}' \
    "$HOST/v1/chat/completions" -H 'Content-Type: application/json' \
    -d "{\"model\":\"$MODEL\",\"messages\":[{\"role\":\"user\",\"content\":\"ok\"}],\"max_tokens\":8,\"temperature\":0}" 2>/dev/null
}

echo "gate: waiting for $MODEL on $HOST (reload it in LM Studio to start)"
for i in $(seq 1 240); do          # up to ~2h of 30s polls
  code=$(probe)
  if [ "$code" = "200" ]; then echo "gate: healthy after $((i*30))s"; break; fi
  [ $((i % 4)) -eq 0 ] && echo "gate: still down (http=$code, ${i}0s elapsed)"
  sleep 30
done
[ "$(probe)" = "200" ] || { echo "gate: never came healthy — aborting"; exit 1; }

# --- benchmark: 1 connection vs 2 -------------------------------------------
PROMPT=$(python3 - <<'PY'
import json
code = 'def search(request):\n    q = request.args.get("q")\n    return db.execute("SELECT * FROM t WHERE n = \'" + q + "\'")\n' * 30
print(json.dumps({"model":"__M__","messages":[{"role":"user","content":"Review for security defects, briefly.\n\n"+code}],"max_tokens":300,"temperature":0}))
PY
)
req() { echo "${PROMPT/__M__/$MODEL}" > /tmp/lmreq.json
        curl -s -m 900 "$HOST/v1/chat/completions" -H 'Content-Type: application/json' --data-binary @/tmp/lmreq.json; }

echo; echo "benchmark: warming up"; req > /dev/null

echo "benchmark: 1 connection (2 requests, serial)"
t0=$(date +%s.%N); req > /tmp/s1.json; req > /tmp/s2.json; t1=$(date +%s.%N)
SER=$(python3 -c "
import json,sys
c=sum(json.load(open(f)).get('usage',{}).get('completion_tokens',0) for f in ['/tmp/s1.json','/tmp/s2.json'])
w=$t1-$t0; print(f'{c} {w:.1f} {c/w:.2f}')")
echo "  completion_tokens=$(echo $SER|cut -d' ' -f1)  wall=$(echo $SER|cut -d' ' -f2)s  aggregate=$(echo $SER|cut -d' ' -f3) t/s"

echo "benchmark: 2 connections (2 requests, parallel)"
t0=$(date +%s.%N); req > /tmp/p1.json & req > /tmp/p2.json & wait; t1=$(date +%s.%N)
PAR=$(python3 -c "
import json
c=sum(json.load(open(f)).get('usage',{}).get('completion_tokens',0) for f in ['/tmp/p1.json','/tmp/p2.json'])
w=$t1-$t0; print(f'{c} {w:.1f} {c/w:.2f}')")
echo "  completion_tokens=$(echo $PAR|cut -d' ' -f1)  wall=$(echo $PAR|cut -d' ' -f2)s  aggregate=$(echo $PAR|cut -d' ' -f3) t/s"

SPEEDUP=$(python3 -c "print(f'{$(echo $PAR|cut -d' ' -f3)/max($(echo $SER|cut -d' ' -f3),0.01):.2f}')")
echo "  speedup from 2 parallel: ${SPEEDUP}x"
CONC=$(python3 -c "print(2 if $SPEEDUP > 1.3 else 1)")
echo "  → concurrency $CONC ($([ "$CONC" = 2 ] && echo 'parallelism helps' || echo 'requests serialize'))"

# --- corpus scan -------------------------------------------------------------
echo; echo "corpus scan: starting at concurrency $CONC"
cd "$REPO" && node --experimental-strip-types eval/corpus/run.ts \
  --corpus /tmp/corpus-small --provider lmstudio --model "$MODEL" \
  --concurrency "$CONC" --timeout 2700000 2>&1 | grep -vE '^\(node:'
