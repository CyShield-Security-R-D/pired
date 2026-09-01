---
name: ops-severity-cvss
description: Use when scoring a finding — pick severity (info→critical), build a CVSS v4.0 vector (v3.1 only when the engagement requires it), and map to the right CWE, with worked examples for common bug classes.
---

# Severity, CVSS v4.0 & CWE mapping

Goal: assign a defensible `severity`, a correct `cvss` vector, and the most specific `cwe` to each finding. Consistency matters more than perfection — score by real impact and exploitability, not by how exciting the bug feels.

**pired records CVSS v4.0 by default.** v3.1 is accepted when the engagement calls for it (a client programme that mandates it, a CVE that only publishes a 3.1 vector) — say so in the description when you use it. `record` validates the vector against the version its own prefix claims and rejects a mismatch, so a v3.1 vector cannot enter the ledger wearing a `CVSS:4.0/` label.

## 1. Pick a severity band
`info | low | medium | high | critical`. Anchor to impact × exploitability:

| Severity | Rule of thumb |
|----------|---------------|
| **critical** | Unauthenticated (or trivially authenticated) path to full compromise / mass data exposure: RCE, auth bypass to admin, unauth DB access, SSRF→cloud-metadata→takeover. Usually CVSS ≥ 9.0. |
| **high** | Serious impact but with a precondition (needs a low-priv account, user interaction, or specific config): IDOR exposing PII, SQLi (data read), stored XSS in an app context, privilege escalation. ~7.0–8.9. |
| **medium** | Real but limited: reflected XSS, CSRF on a meaningful action, info leak of non-critical data, missing hardening that enables another attack. ~4.0–6.9. |
| **low** | Minor/defense-in-depth: verbose errors, missing security headers, weak TLS ciphers, self-XSS, autocomplete on. ~0.1–3.9. |
| **info** | No direct security impact; observations, recon leads, best-practice notes. The default for unexploited leads in the `recon` profile. |

Qualitative bands (unchanged from v3.1 — the ratings moved, the bands did not): **None 0.0 · Low 0.1–3.9 · Medium 4.0–6.9 · High 7.0–8.9 · Critical 9.0–10.0.**

Let the CVSS score sanity-check the band, but the band is the human judgment — a "high" CVSS on an unreachable code path is not a high finding, and a mid-band base can be raised on proven business impact (e.g. bulk PII). When you move off the base score, say why in the description.

## 2. Build a CVSS v4.0 vector
Format (store this whole string in the finding's `cvss` field). All eleven Base metrics are mandatory and must appear in this order — v4.0 has no "not defined" for a Base metric:
```
CVSS:4.0/AV:_/AC:_/AT:_/PR:_/UI:_/VC:_/VI:_/VA:_/SC:_/SI:_/SA:_
```
**Exploitability**
- **AV** Attack Vector — `N` network / `A` adjacent / `L` local / `P` physical. Internet-reachable = `N`.
- **AC** Attack Complexity — `L` low / `H` high. In v4.0 `H` means the attacker must **defeat a security measure** (bypass ASLR, defeat a token check), not merely that conditions are awkward.
- **AT** Attack Requirements — `N` none / `P` present. **New in v4.0**, and it takes the other half of what v3.1's `AC:H` used to carry: preconditions **outside the attacker's control** — a race window, a specific config, a machine-in-the-middle position. Splitting these is the single most common v4.0 scoring mistake: an unauthenticated SQLi is `AC:L/AT:N`, a TOCTOU race is `AC:L/AT:P`.
- **PR** Privileges Required — `N` none / `L` low (a normal user account) / `H` high (admin).
- **UI** User Interaction — `N` none / `P` **passive** (the victim just uses the app normally: stored XSS on a page they visit) / `A` **active** (the victim must be induced to act: click a crafted link, import a file). v3.1's single `R` splits here.

**Impact — the vulnerable system, then what it reaches next.** v4.0 has no Scope metric; this pair replaces it, and it is more expressive: say what the vulnerable component loses *and* what falls with it.
- **VC / VI / VA** — Confidentiality / Integrity / Availability of the **vulnerable system**, each `H` / `L` / `N`.
- **SC / SI / SA** — the same three for the **subsequent system(s)** the exploit reaches. This is where v3.1's `S:C` went: XSS impacts the browser (`SC`/`SI`), SSRF impacts the internal service it reaches, a container escape impacts the host.

**Optional, and worth adding when you know them:**
- Threat: `E` Exploit Maturity — `A` attacked (in-the-wild) / `P` proof-of-concept / `U` unreported / `X` not defined. This is the only Threat metric in v4.0 (Remediation Level and Report Confidence are gone).
- Environmental: `CR`/`IR`/`AR` (what the client actually cares about) and the modified base metrics `MAV`…`MSA`. Use these when the client's environment genuinely changes the score, and say in the description that you did.
- Supplemental (recorded, never scored): `S` Safety, `AU` Automatable, `R` Recovery, `V` Value Density, `RE` Response Effort, `U` Provider Urgency. `AU:Y` and `S:P` are worth stating on findings where they are true — they change how a client prioritises even though they do not move the number.

Nomenclature: Base only = **CVSS-B**, with Threat = **CVSS-BT**, with Environmental = **CVSS-BE**, both = **CVSS-BTE**. Say which one you are quoting if you quote a number.

**Do not compute the score by hand.** v4.0 replaced the v3.1 formula with a lookup over 270 macrovector equivalence classes plus interpolation; there is no arithmetic to do in your head, and an estimate that lands one band out is worse than no number. Build and read the score at **https://www.first.org/cvss/calculator/4-0** — the vector string is what you record either way.

### If the engagement requires v3.1
Use the v3.1 metric set in full, under its own prefix — never a v3.1 vector relabelled as 4.0:
```
CVSS:3.1/AV:_/AC:_/PR:_/UI:_/S:_/C:_/I:_/A:_
```
`AC` carries both meanings again, `UI` is `N|R`, and `S:C` (scope change) replaces the VC…SA split. Calculator: https://www.first.org/cvss/calculator/3-1.

## 3. Map to CWE (be specific)
Pick the single most precise CWE (findings take one `cwe`; the checklist class may list several). Typical v4.0 base vectors:

| Bug class | CWE | Typical v4.0 vector (from `CVSS:4.0/`) | Typical severity |
|-----------|-----|----------------------------------------|------------------|
| SQL injection (data read) | CWE-89 | `AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N` | high–critical |
| OS command injection / RCE | CWE-78 (or CWE-77) | `AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N` | critical |
| IDOR / broken object-level authz | CWE-639 (parent CWE-284) | `AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N` | high |
| Missing auth / unauth access | CWE-306 | `AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N` | critical |
| Reflected XSS | CWE-79 | `AV:N/AC:L/AT:N/PR:N/UI:A/VC:N/VI:N/VA:N/SC:L/SI:L/SA:N` | medium |
| Stored XSS | CWE-79 | `AV:N/AC:L/AT:N/PR:L/UI:P/VC:N/VI:N/VA:N/SC:H/SI:L/SA:N` | high |
| SSRF | CWE-918 | `AV:N/AC:L/AT:N/PR:L/UI:N/VC:L/VI:N/VA:N/SC:H/SI:L/SA:N` | high–critical |
| Path traversal / LFI | CWE-22 | `AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N` | high |
| Insecure deserialization | CWE-502 | `AV:N/AC:L/AT:P/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N` | high–critical |
| SSTI | CWE-1336 (or CWE-94) | `AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N` | high–critical |
| CSRF | CWE-352 | `AV:N/AC:L/AT:N/PR:N/UI:A/VC:N/VI:H/VA:N/SC:N/SI:N/SA:N` | medium |
| XXE | CWE-611 | `AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:L/SC:L/SI:N/SA:N` | high |
| Hardcoded / exposed secret | CWE-798 (or CWE-200) | `AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N` | high–critical |
| Sensitive data exposure (dir listing, backup, .git) | CWE-538/CWE-540/CWE-200 | `AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N` | medium–high |
| Default credentials | CWE-1392 (or CWE-1188) | `AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N` | high–critical |
| Missing security headers / weak TLS | CWE-693 / CWE-319 / CWE-327 | `AV:N/AC:H/AT:P/PR:N/UI:P/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N` | low |

These are **starting points, not answers** — `AV`, `PR`, `AT` and the subsequent-system impacts all depend on the actual deployment. Adjust from what you observed, then read the score off the calculator.

> Map to a specific weakness, not a CWE **category**: CWE-16 (*Configuration*) is a category MITRE marks **Prohibited** for mapping. `cwe=CWE-284` is a broad class (allowed only with review) — prefer the child (CWE-639 for IDOR) and note the parent in prose if useful.

## 4. Worked examples
Vectors are given in full; get the number from the calculator rather than from memory or from a v3.1 habit — v4.0 rates many of these differently from v3.1, and quoting a remembered 3.1 number beside a 4.0 vector is the mistake this section exists to prevent.

- **Unauthenticated RCE on an internet-facing service** → CWE-78, `CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N`. Everything on the vulnerable host falls; nothing beyond it is claimed unless you actually pivoted, in which case raise `SC/SI/SA` and say what you reached. Rate **critical**.
- **Unauth Redis on an internal host** → CWE-306, `CVSS:4.0/AV:A/AC:L/AT:N/PR:N/UI:N/VC:H/VI:H/VA:H/SC:N/SI:N/SA:N` when it is adjacent/internal-only; the same vector with `AV:N` when it is genuinely internet-reachable. Pick `AV` from real reachability, not habit — it is the single biggest swing in the score.
- **IDOR reading other users' profiles** → CWE-639, `CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N`. Needs a login (`PR:L`), reads confidential data (`VC:H`), changes nothing (`VI:N`), and reaches no other system (`SC:N`). Often **recorded high** on business impact when the exposure is bulk PII — that is an explicit judgment above the base score, so state the reason in the description (§1).
- **Reflected XSS in a search param** → CWE-79, `CVSS:4.0/AV:N/AC:L/AT:N/PR:N/UI:A/VC:N/VI:N/VA:N/SC:L/SI:L/SA:N`. The victim must be induced to click (`UI:A`), the server itself loses nothing (`VC/VI/VA:N`), and the impact lands on the browser — the subsequent system (`SC:L/SI:L`). This pair of choices is the v4.0 replacement for `S:C` and it is where most mis-scored XSS comes from.
- **Stored XSS on a page every user loads** → same CWE, `UI:P` rather than `UI:A`: the victim does nothing unusual. That distinction did not exist in v3.1.
- **TOCTOU race in a payment flow** → `AC:L/AT:P`: no security measure is being defeated (`AC:L`), but the attacker needs a window they do not control (`AT:P`). Under v3.1 this was `AC:H` and the two causes were indistinguishable.
- **Missing HSTS header** → CWE-693, `CVSS:4.0/AV:N/AC:H/AT:P/PR:N/UI:P/VC:L/VI:N/VA:N/SC:N/SI:N/SA:N`. Defense-in-depth: it needs a machine-in-the-middle position (`AT:P`) to matter at all. Rate **low** and say in the description that it is only exploitable alongside a network position.

## 5. Record it
Put the vector and CWE straight into the finding:
```
record kind=finding id=f3a9 severity=high cwe=CWE-639 \
  cvss="CVSS:4.0/AV:N/AC:L/AT:N/PR:L/UI:N/VC:H/VI:N/VA:N/SC:N/SI:N/SA:N"
```
- One `cwe` per finding (the most specific); note alternates in the description if genuinely ambiguous.
- Keep severity ↔ CVSS ↔ CWE internally consistent; if they disagree, re-examine the real-world impact before recording.
- If `record` rejects the vector, read the message — it names the metric and the version. Do not "fix" a v3.1 vector by editing the prefix: rebuild it from the v4.0 metrics, because Scope is gone and `AT` is new.
- When unsure between two bands, state the assumption in the description and lean to the lower band unless impact is proven — honesty over inflation.

## References
- CVSS v4.0 Specification Document — FIRST — https://www.first.org/cvss/v4-0/specification-document (metric definitions, vector-string format, nomenclature, macrovector scoring)
- CVSS v4.0 User Guide — FIRST — https://www.first.org/cvss/v4-0/user-guide (the AC/AT split, UI:P vs UI:A, worked scoring rubric)
- CVSS v4.0 Calculator — FIRST — https://www.first.org/cvss/calculator/4-0 (build the vector, read the score and the band)
- CVSS v3.1 Specification + Calculator — FIRST — https://www.first.org/cvss/v3-1/specification-document · https://www.first.org/cvss/calculator/3-1 (for an engagement that requires v3.1)
- CWE List — MITRE — https://cwe.mitre.org/ (verify each id: CWE-639, CWE-79, CWE-89, CWE-1336, CWE-1392; categories like CWE-16 are Prohibited for mapping)
- OWASP Risk Rating Methodology — OWASP — https://owasp.org/www-community/OWASP_Risk_Rating_Methodology (likelihood × impact, for defending the human band)
