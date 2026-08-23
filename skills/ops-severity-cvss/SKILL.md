---
name: ops-severity-cvss
description: Use when scoring a finding — pick severity (info→critical), build a CVSS v3.1 vector, and map to the right CWE, with worked examples for common bug classes.
---

# Severity, CVSS v3.1 & CWE mapping

Goal: assign a defensible `severity`, a correct `cvss` vector, and the most specific `cwe` to each finding. Consistency matters more than perfection — score by real impact and exploitability, not by how exciting the bug feels.

## 1. Pick a severity band
`info | low | medium | high | critical`. Anchor to impact × exploitability:

| Severity | Rule of thumb |
|----------|---------------|
| **critical** | Unauthenticated (or trivially authenticated) path to full compromise / mass data exposure: RCE, auth bypass to admin, unauth DB access, SSRF→cloud-metadata→takeover. Usually CVSS ≥ 9.0. |
| **high** | Serious impact but with a precondition (needs a low-priv account, user interaction, or specific config): IDOR exposing PII, SQLi (data read), stored XSS in an app context, privilege escalation. ~7.0–8.9. |
| **medium** | Real but limited: reflected XSS, CSRF on a meaningful action, info leak of non-critical data, missing hardening that enables another attack. ~4.0–6.9. |
| **low** | Minor/defense-in-depth: verbose errors, missing security headers, weak TLS ciphers, self-XSS, autocomplete on. ~0.1–3.9. |
| **info** | No direct security impact; observations, recon leads, best-practice notes. The default for unexploited leads in the `recon` profile. |

Let the CVSS score sanity-check the band, but the band is the human judgment — a "high" CVSS on an unreachable code path is not a high finding.

## 2. Build a CVSS v3.1 vector
Format (store this whole string in the finding's `cvss` field):
```
CVSS:3.1/AV:_/AC:_/PR:_/UI:_/S:_/C:_/I:_/A:_
```
Base metrics:
- **AV** Attack Vector — `N` network / `A` adjacent / `L` local / `P` physical. Internet-reachable = `N`.
- **AC** Attack Complexity — `L` low (repeatable, no special conditions) / `H` high (race, specific config).
- **PR** Privileges Required — `N` none / `L` low (a normal user account) / `H` high (admin).
- **UI** User Interaction — `N` none / `R` required (victim must click/visit).
- **S** Scope — `U` unchanged / `C` changed (breaks out of the vulnerable component's authority, e.g. SSRF reaching other systems, XSS as scope-change to the browser). Scope `C` raises the score notably.
- **C/I/A** Confidentiality/Integrity/Availability impact — each `N` none / `L` low / `H` high.

Compute/verify the numeric score and severity with the official calculator (`nvd.nist.gov/vuln-metrics/cvss/v3-calculator`) rather than guessing the number; the vector string is what you record either way.

## 3. Map to CWE (be specific)
Pick the single most precise CWE (findings take one `cwe`; the checklist class may list several). Common ones:

| Bug class | CWE | Typical vector | Typical severity |
|-----------|-----|----------------|------------------|
| SQL injection (data read) | CWE-89 | `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N` | high–critical |
| OS command injection / RCE | CWE-78 (or CWE-77) | `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` | critical |
| IDOR / broken object-level authz | CWE-639 (parent CWE-284) | `AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N` | high |
| Missing auth / unauth access | CWE-306 | `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` | critical |
| Reflected XSS | CWE-79 | `AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N` | medium |
| Stored XSS | CWE-79 | `AV:N/AC:L/PR:L/UI:R/S:C/C:H/I:L/A:N` | high |
| SSRF | CWE-918 | `AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:L/A:N` | high–critical |
| Path traversal / LFI | CWE-22 | `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N` | high |
| Insecure deserialization | CWE-502 | `AV:N/AC:H/PR:N/UI:N/S:U/C:H/I:H/A:H` | high–critical |
| SSTI | CWE-1336 (or CWE-94) | `AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:H/A:H` | high–critical |
| CSRF | CWE-352 | `AV:N/AC:L/PR:N/UI:R/S:U/C:N/I:H/A:N` | medium |
| XXE | CWE-611 | `AV:N/AC:L/PR:L/UI:N/S:C/C:H/I:N/A:L` | high |
| Hardcoded / exposed secret | CWE-798 (or CWE-200 for info exposure) | `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N` | high–critical |
| Sensitive data exposure (dir listing, backup, .git) | CWE-538/CWE-540/CWE-200 | `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:N/A:N` | medium–high |
| Default credentials | CWE-1392 (or CWE-1188 default config) | `AV:N/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` | high–critical |
| Missing security headers / weak TLS | CWE-16 / CWE-693 / CWE-327 | `AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N` | low |

## 4. Worked examples
- **Unauth Redis on an internal host** → CWE-306, `CVSS:3.1/AV:A/AC:L/PR:N/UI:N/S:U/C:H/I:H/A:H` (adjacent if internal-only; `AV:N` if internet-reachable) → **critical**. Full read/write with no auth.
- **IDOR reading other users' profiles** → CWE-639, `CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N` (7.1) → **high**. Needs a login (`PR:L`), reads confidential data (`C:H`).
- **Reflected XSS in a search param** → CWE-79, `CVSS:3.1/AV:N/AC:L/PR:N/UI:R/S:C/C:L/I:L/A:N` (6.1) → **medium**. Victim must click (`UI:R`); scope-change to browser (`S:C`).
- **Missing HSTS header** → CWE-693, `CVSS:3.1/AV:N/AC:H/PR:N/UI:R/S:U/C:L/I:N/A:N` (~3.1) → **low**. Defense-in-depth.

## 5. Record it
Put the vector and CWE straight into the finding:
```
record kind=finding id=f3a9 severity=high cwe=CWE-639 cvss="CVSS:3.1/AV:N/AC:L/PR:L/UI:N/S:U/C:H/I:N/A:N"
```
- One `cwe` per finding (the most specific); note alternates in the description if genuinely ambiguous.
- Keep severity ↔ CVSS ↔ CWE internally consistent; if they disagree, re-examine the real-world impact before recording.
- When unsure between two bands, state the assumption in the description and lean to the lower band unless impact is proven — honesty over inflation.
