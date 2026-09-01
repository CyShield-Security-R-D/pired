---
name: ops-evidence
description: Use when a tool produces bulky output — redirect raw output to evidence/ files, capture request/response pairs, pull only distilled summaries into context.
---

# Evidence discipline & context hygiene

Goal: keep raw tool output OUT of the conversation and IN files, so context stays small and the model stays sharp (principle 8; especially important for weak local models). The rule: **raw output → `evidence/` file; distilled summary → `record`/`note` → context.** Evidence files also back your findings — a finding without a saved artifact is hard to defend.

## Why this matters
- Context is the scarce resource. A 5,000-line nmap/ffuf dump pasted into the chat drowns the signal and can push scope/findings out of the compaction window.
- Findings need durable proof. `evidence/` and `artifacts/` live in the engagement workspace (`~/.pired/engagements/<name>/`), survive across sessions, and are referenced by workspace-relative path from records.

## 0. `evidence/` is in the WORKSPACE, not where your shell is standing
This is the one thing to get right, and the easy mistake. Your shell starts in the **target** directory; the workspace is somewhere else entirely. `> evidence/x.txt` therefore writes into the target, which is not where records are resolved from — and citing it back reads as an unsupported claim on a file you really did write.

`$PIRED_WORKSPACE` is exported into your shell, and the absolute path is in your system prompt. Write there:
```bash
mkdir -p "$PIRED_WORKSPACE/evidence"
curl -sSv 'https://app.TARGET/api/user?id=1002' > "$PIRED_WORKSPACE/evidence/y7-idor.txt" 2>&1
```
Then cite the **workspace-relative** path — `evidence/y7-idor.txt` — never the absolute one.

Two safety nets, neither of which is a reason to skip the above: `record kind=evidence name=... content=...` writes the file for you and returns the exact path to cite, and a cited path that turns out to be under your working directory is copied into the workspace automatically (the tool tells you when it does). Binaries are not copied — write screenshots and dumps straight into `"$PIRED_WORKSPACE/artifacts/"`.

## 1. Redirect raw output to a file, read back only what matters
```bash
# capture everything to a file; keep it out of context
nmap -sV -sC -p- 10.10.20.7 -oA "$PIRED_WORKSPACE/evidence/nmap_h7" > /dev/null 2>&1
# now pull only the distilled lines into context
grep -E '^[0-9]+/tcp' "$PIRED_WORKSPACE/evidence/nmap_h7.nmap"   # just the open-port table
```
Patterns:
- Prefer a tool's own output flag (`-oA`, `-o file`, `-oN`, `-of json`) over piping the whole thing to the screen.
- For chatty tools, redirect then `grep`/`jq`/`head` back the essence: `... > "$PIRED_WORKSPACE/evidence/x.txt" 2>&1; grep -i <signal> "$PIRED_WORKSPACE/evidence/x.txt"`.
- `tee` when you want both a file and a quick glance: `whatweb -a3 URL | tee "$PIRED_WORKSPACE/evidence/whatweb.txt" | head`.
- Even bash auto-truncates long output — don't rely on that; redirect on purpose so nothing important is lost mid-buffer.

## 2. Capture request/response pairs (the gold-standard web evidence)
```bash
# full request headers + response headers + body to one file
curl -sS -D "$PIRED_WORKSPACE/evidence/y7-idor.headers" 'https://app.TARGET/api/user?id=1002' \
     -o "$PIRED_WORKSPACE/evidence/y7-idor.body"
# or a single dump with the request line visible
curl -sSv 'https://app.TARGET/api/user?id=1002' > "$PIRED_WORKSPACE/evidence/y7-idor.txt" 2>&1
```
- Name the file after the record it backs: `evidence/<id>-<slug>.txt` (e.g. `evidence/y7-idor.txt`, `evidence/f3a9-req.http`). The referencing record IS the index — no separate index file needed.
- For a proof that needs before/after (IDOR, authz), save both requests: `evidence/y7-userA.txt`, `evidence/y7-userB.txt`.
- Screenshots and PoC scripts go in `artifacts/` (e.g. `artifacts/f3a9-screenshot.png`).

## 3. Distill into the workspace, not the transcript
After capturing, record the takeaway — not the dump:
```
record kind=note text="nmap h7: 22,445,3389,5985 open; Win2019; SMB signing not required"
record kind=service host=h1 port=445 proto=tcp name=microsoft-ds
```
Then, when you promote a finding, point it at the files:
```
record kind=finding title="IDOR in /api/user" severity=high target=e1 class=authz cwe=CWE-639 evidence=["evidence/y7-userA.txt","evidence/y7-userB.txt"]
```

## 4. Naming & layout conventions
```
evidence/
  hostsweep.gnmap            # broad scans keyed by phase
  h7-smb.txt                 # per-host/service, keyed by inventory id where possible
  y7-idor.txt                # per-hypothesis, keyed by hypothesis id
  f3a9-req.http              # per-finding, keyed by finding id
artifacts/
  f3a9-screenshot.png        # screenshots, dumped files, PoC scripts
```
- Embed the referencing id in the filename so evidence and record stay linked.
- Keep secrets OUT of filenames; refer to loot by handle (see `ops-loot-credentials`).

## 5. Checklist
- [ ] Bulky output was redirected to `"$PIRED_WORKSPACE/evidence/"`, not to the target directory and not pasted into context.
- [ ] Only a distilled summary / structured `record` entered context.
- [ ] Every finding references at least one `evidence/` (or `artifacts/`) path.
- [ ] Files are named after the id they back; request+response captured for web PoCs.
- [ ] No plaintext secrets embedded in evidence filenames or context (mask/handle them).

The point is no-loss: the file preserves the raw proof even after compaction discards the transcript, and the `record` preserves the takeaway. Capture at the moment of observation — an artifact you meant to save later is an artifact you lose.

## References
- PTES — Reporting — Penetration Testing Execution Standard — https://pentest-standard.readthedocs.io/en/latest/reporting.html (findings must be backed by reproducible evidence)
- PTES — Pre-engagement Interactions — Penetration Testing Execution Standard — https://pentest-standard.readthedocs.io/en/latest/preengagement_interactions.html (rules of engagement cover evidence handling and storage)
- Technical Guide to Information Security Testing and Assessment — NIST SP 800-115 — https://csrc.nist.gov/pubs/sp/800/115/final (documenting results, handling assessment data)
