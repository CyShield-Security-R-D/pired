---
name: ops-loot-credentials
description: Use when you capture or reuse a secret — record kind=loot with a stable handle, refer by handle instead of reprinting plaintext, rely on redaction at export.
---

# Capturing & reusing secrets safely

Goal: capture every credential/secret once into the workspace with a **stable handle**, then refer to it by that handle everywhere else — never reprinting the plaintext across the transcript. Reuse is by handle; the plaintext lives only in the chmod-600 loot file and is masked automatically at every boundary that leaves the machine.

## 1. Record loot with a handle
The moment you obtain a secret (password, hash, token, API key, cookie, private key), record it:
```
record kind=loot handle=cred:web-admin lootType=password username=admin secret="S3cr3t!" target=h1 source=y5 notes="Reused on SSH"
```
Fields:
- **handle** (required) — a stable, human-readable reference, conventionally `cred:<scope>-<role>` (`cred:web-admin`, `cred:db-postgres`, `token:api-ci`). This is what you type everywhere else.
- **secret** (required) — the plaintext/hash. Written **only** to `loot.jsonl` (chmod 600) in the engagement workspace, outside the target tree.
- **lootType** — `password | hash | token | apikey | cookie | key`.
- **username / target / source** — who it's for, which inventory element/host, and how you got it (a hypothesis/evidence ref) — so the chain is auditable.

Record it once. If you later crack a hash or rotate to a new value, record the result as **new loot under its own handle** (e.g. `cred:web-admin-cracked`), don't overwrite the provenance.

## 2. Reference by handle — never reprint the secret
- In notes, hypotheses, findings, task hand-offs, and chat: write the **handle**, not the value. "Authenticated to SSH as `cred:web-admin`" — not the password.
- `recall loot` returns **handles only** (`cred:web-admin (password admin @ h1)`), never the plaintext — safe to pull into context.
- Reusing a captured cred later? Read it from the workspace at the point of use; don't paste it back into the conversation to "have it handy". The transcript is the leak vector you're avoiding.
- When you must actually supply the secret to a tool, prefer piping/env over echoing it into context: e.g. read it from the loot file at execution time rather than typing the literal into a visible command.

## 3. Redaction guarantee (why the handle discipline is enough)
Redaction is registry-based and applied at export/share (PLAN.md §9, `core/redaction.ts`):
- Every secret in `loot.jsonl` is masked to `[REDACTED <handle>]` in **findings export** (`/findings`, Markdown/JSON) and any share/publish path — traceable, not just blanked.
- It masks **only values the operator actually captured** (registry-based), so false positives are ~zero and real secrets don't slip through.
- Longest-secret-first matching means a secret that's a prefix of another can't leave a tail behind.
- **Caveat:** redaction protects the *export/share* boundary, not the live session JSONL (which may contain what the model saw — fine, it's local). So the plaintext still shouldn't be sprayed through context: record it as loot promptly so it's in the registry and masked on the way out.

## 4. Handling & hygiene
- **loot.jsonl is chmod 600 and lives outside the target tree** (`~/.pired/engagements/<name>/`) so it never lands in a repo under review. Don't copy secrets into `evidence/` filenames or the target directory.
- Loot is **never auto-shared**. Only findings export leaves the machine, and it's masked.
- Display masking in the UI is off by default (operators usually want to see what they captured) — that's a display choice, independent of the export guarantee.
- Treat keys/tokens as loot too (`lootType=key`/`token`), with the private-key body as `secret` and a handle like `key:ssh-www-data`.

## 5. In the loop
```
record kind=loot handle=cred:db-postgres lootType=password username=postgres secret="postgres" target=s4 source=y9 notes="default cred, unauth on 5432"
record kind=finding title="Default PostgreSQL credentials on 10.10.20.9" severity=critical target=s4 class=misconfig cwe=CWE-1392 description="postgres/postgres grants full DB access; see cred:db-postgres" evidence=["evidence/y9-psql.txt"]
```
- Note in the finding refers to the loot by **handle**, never the password — the export stays clean automatically.
- For post-exploitation cred reuse and the approval gate around it, see `network-post-exploit-notes`.
