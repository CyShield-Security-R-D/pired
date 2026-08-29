#!/usr/bin/env bash
# Engagement state panel — the data pired is accumulating, at a glance.
#
#   eval/panel.sh [engagement-name]     # omit to follow whichever is active
#
# The TUI shows the conversation and a one-line status; this shows the ledger:
# scope, coverage, what has been mapped, what has been settled, what was found.
# Intended as an optional tmux pane beside a running review.
set -uo pipefail
REFRESH="${REFRESH:-5}"

while true; do
  NAME="${1:-}"
  if [ -z "$NAME" ]; then
    p=$(pgrep -x pi 2>/dev/null | while read -r q; do
          case "$(readlink /proc/$q/cwd 2>/dev/null)" in /tmp/corpus*|/tmp/dvbank*) basename "$(readlink /proc/$q/cwd)"; break;; esac
        done)
    NAME="$p"
    # Between targets — or after a run ends — there is no process to read the
    # name from, but the state is still worth showing. Fall back to whichever
    # engagement was written most recently.
    [ -z "$NAME" ] && NAME=$(ls -t "$HOME/.pired/engagements" 2>/dev/null | head -1)
  fi
  D="$HOME/.pired/engagements/$NAME"

  clear
  if [ -z "$NAME" ] || [ ! -d "$D" ]; then
    echo "  no active engagement"
    sleep "$REFRESH"; continue
  fi

  python3 - "$D" "$NAME" <<'PY'
import json, os, sys
from collections import Counter
d, name = sys.argv[1], sys.argv[2]

def rows(f):
    p = os.path.join(d, f + ".jsonl")
    if not os.path.exists(p): return []
    out = {}
    for line in open(p):
        line = line.strip()
        if not line: continue
        try: r = json.loads(line)
        except Exception: continue
        if isinstance(r, dict) and r.get("id"): out[r["id"]] = r
    return [r for r in out.values() if not r.get("deleted")]

def rule(t=""):
    print(f"\033[2m──\033[0m \033[1m{t}\033[0m " + "\033[2m" + "─"*(46-len(t)) + "\033[0m" if t else "\033[2m" + "─"*50 + "\033[0m")

TYPE = {"code-review": "review · source audit",
        "web": "pentest · web application",
        "api": "pentest · API",
        "network": "pentest · network"}
tt = None
cl_path = os.path.join(d, "checklist.json")
if os.path.exists(cl_path):
    try: tt = json.load(open(cl_path)).get("targetType")
    except Exception: tt = None
kind = TYPE.get(tt, tt or "unknown")
mtime = os.path.getmtime(d)
import time
age = int((time.time() - mtime) / 60)
print(f"\033[1;31m⦿\033[0m \033[1m{name}\033[0m")
print(f"   \033[2m{kind} · last write {age}m ago\033[0m\n")

# --- scope -----------------------------------------------------------------
rule("scope")
sp = os.path.join(d, "scope.json")
if os.path.exists(sp):
    s = json.load(open(sp))
    t = s.get("targets", {}) or {}
    print(f"   mode {s.get('mode','?')} · {'authorized' if s.get('authorized') else 'NOT authorized'}")
    for k in ("domains", "ips", "cidrs", "urls"):
        if t.get(k): print(f"   {k:8s} {', '.join(t[k])[:44]}")
    if s.get("exclude"): print(f"   exclude  {json.dumps(s['exclude'])[:44]}")
else:
    print("   \033[2mno scope file — local review\033[0m")

# --- coverage ---------------------------------------------------------------
print()
rule("coverage")
cl = os.path.join(d, "checklist.json")
inv, hyp, fnd = rows("inventory"), rows("hypotheses"), rows("findings")
if os.path.exists(cl):
    classes = json.load(open(cl)).get("classes", [])
    surface = [r for r in inv if r.get("kind") in ("endpoint", "host")]
    settled = {(h.get("target"), h.get("class")) for h in hyp if h.get("outcome") in ("confirmed", "refuted")}
    cells = len(classes) * max(len(surface), 0)
    pct = round(100 * len(settled) / cells) if cells else 0
    bar = "█" * (pct // 5) + "\033[2m" + "░" * (20 - pct // 5) + "\033[0m"
    print(f"   {bar} {pct}%")
    print(f"   {len(classes)} classes × {len(surface)} surface = {cells} cells · {len(settled)} settled")
else:
    print("   \033[2mno checklist seeded\033[0m")

# --- inventory --------------------------------------------------------------
print()
rule(f"surface ({len(inv)})")
for kind, n in Counter(r.get("kind") for r in inv).most_common():
    print(f"   {str(kind):10s} {n}")
for r in inv[-4:]:
    label = r.get("path") or r.get("value") or r.get("name") or ""
    print(f"   \033[2m· {str(label)[:44]}\033[0m")

# --- hypotheses -------------------------------------------------------------
print()
rule(f"hypotheses ({len(hyp)})")
oc = Counter(h.get("outcome") for h in hyp)
colour = {"confirmed": "31", "refuted": "32", "testing": "33", "proposed": "36", "inconclusive": "35"}
for o, n in oc.most_common():
    print(f"   \033[{colour.get(o,'0')}m{str(o):13s}\033[0m {n}")

# --- findings ---------------------------------------------------------------
print()
rule(f"findings ({len(fnd)})")
sev = Counter(f.get("severity") for f in fnd)
for s in ("critical", "high", "medium", "low", "info"):
    if sev.get(s):
        c = {"critical":"1;31","high":"31","medium":"33","low":"36","info":"2"}[s]
        print(f"   \033[{c}m{s:9s}\033[0m {sev[s]}")
for f in fnd[-3:]:
    print(f"   \033[2m· [{f.get('severity','?')}] {str(f.get('title',''))[:40]}\033[0m")

ev = os.path.join(d, "evidence")
n_ev = len(os.listdir(ev)) if os.path.isdir(ev) else 0
blockers = rows("blockers")
print()
print(f"   evidence {n_ev} · blockers {len([b for b in blockers if b.get('status')=='open'])} open")
PY
  sleep "$REFRESH"
done
