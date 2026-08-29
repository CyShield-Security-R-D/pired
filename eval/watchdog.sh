#!/usr/bin/env bash
# Kill an eval run that is burning credit without making progress.
#
# The naive liveness check — "is the proxy still seeing requests" — stopped being
# useful once subagent delegation started working: a deadlocked parent's children
# keep calling the model, so spend rises while nothing is recorded. The signature
# that actually separates work from a wedge is:
#
#     spend is increasing  AND  no engagement ledger has grown
#
# That is a run paying for tokens it is not turning into recorded findings, which
# is the exact shape of every stall in this project so far.
#
#   eval/watchdog.sh --prefix dvbank-7m8zki --stall 480 --max-spend 4.00
#
# Kills the pired processes when tripped; the runner then records FAILED for the
# affected targets rather than reporting them as measured zeros.

set -u
PREFIX=""; STALL=480; MAX_SPEND=""; PROXY="http://127.0.0.1:8787/status"; INTERVAL=60
while [ $# -gt 0 ]; do
	case "$1" in
		--prefix) PREFIX="$2"; shift 2 ;;
		--stall) STALL="$2"; shift 2 ;;
		--max-spend) MAX_SPEND="$2"; shift 2 ;;
		--proxy) PROXY="$2"; shift 2 ;;
		--interval) INTERVAL="$2"; shift 2 ;;
		*) shift ;;
	esac
done

ledger_lines() {
	# Total recorded rows across this run's engagements. Growth here is the only
	# evidence that spend is buying anything.
	# -mmin, not -newermt: `-newermt '-5 hours'` silently matches nothing here, so
	# the counter reads 0 forever and a healthy run looks stalled. A liveness probe
	# that cannot observe progress is worse than none — it kills good work.
	find "$HOME/.pired/engagements" -maxdepth 2 -name '*.jsonl' -mmin -300 -path "*${PREFIX}*" -print0 2>/dev/null \
		| xargs -0 cat 2>/dev/null | wc -l
}
spend() { curl -s --max-time 10 "$PROXY" 2>/dev/null | python3 -c "import json,sys;print(json.load(sys.stdin)['spent'])" 2>/dev/null || echo ""; }
agents() { ps -eo cmd | grep -c "[p]ired.mjs"; }

last_lines=$(ledger_lines); last_spend=$(spend); stalled_for=0
echo "watchdog: prefix='${PREFIX}' stall=${STALL}s max-spend=${MAX_SPEND:-none} · start lines=${last_lines} spend=${last_spend:-?}"

while true; do
	sleep "$INTERVAL"
	a=$(agents)
	[ "$a" -eq 0 ] && { echo "watchdog: no agents left — run finished on its own"; exit 0; }

	lines=$(ledger_lines); sp=$(spend)
	if [ -n "$MAX_SPEND" ] && [ -n "$sp" ]; then
		over=$(python3 -c "print(1 if float('$sp') >= float('$MAX_SPEND') else 0)" 2>/dev/null || echo 0)
		if [ "$over" = "1" ]; then
			echo "watchdog: KILL — spend \$${sp} reached the \$${MAX_SPEND} ceiling"
			pkill -9 -f "bin/pired.mjs"; exit 2
		fi
	fi

	burning=0
	if [ -n "$sp" ] && [ -n "$last_spend" ]; then
		burning=$(python3 -c "print(1 if float('$sp') > float('$last_spend') + 0.005 else 0)" 2>/dev/null || echo 0)
	fi

	if [ "$lines" -gt "$last_lines" ]; then
		stalled_for=0
	elif [ "$burning" = "1" ]; then
		# Paying for tokens, recording nothing.
		stalled_for=$((stalled_for + INTERVAL))
	else
		# Neither spending nor recording: idle between targets, not a wedge.
		stalled_for=0
	fi

	echo "watchdog: lines=${lines} spend=\$${sp:-?} agents=${a} stalled=${stalled_for}s"
	if [ "$stalled_for" -ge "$STALL" ]; then
		echo "watchdog: KILL — ${stalled_for}s of spend with no ledger growth (wedge signature)"
		pkill -9 -f "bin/pired.mjs"; exit 3
	fi
	last_lines=$lines; last_spend=$sp
done
