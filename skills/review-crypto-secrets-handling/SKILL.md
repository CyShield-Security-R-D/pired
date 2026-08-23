---
name: review-crypto-secrets-handling
description: Use when reviewing crypto & sensitive-data handling — weak hashes/ciphers, static IV/keys, bad randomness, disabled TLS, secrets in logs. CWE-327/330/916.
---

# Cryptography & sensitive-data handling review

Goal: find broken or misused crypto and sensitive data that leaks through side channels (logs, URLs, errors). The risk is usually a *choice* (which algorithm/mode/RNG), not tainted input — so grep the primitive, then read how it's used. Grep is your enumeration engine here; be exhaustive so no weak primitive slips through.

Tools run via `bash` and may be absent — these are mostly grep + read. Save notes to `evidence/`. Verification sets confidence/severity; keep an un-disproven weak-crypto use as a finding, don't drop it.

## 1. Weak / broken algorithms — CWE-327/328 (class `crypto` · ASVS V6.2 · WSTG-CRYP-04)
```bash
rg -n -i "\bMD2\b|\bMD4\b|\bMD5\b|\bSHA-?1\b|\bDES\b|3des|\bRC2\b|\bRC4\b|\bECB\b|blowfish|createHash\(['\"](md5|sha1)|createCipher\(|MessageDigest\.getInstance\(\"(MD5|SHA-?1)|hashlib\.(md5|sha1)\b|Cipher\.getInstance\(\"(DES|DESede|AES/ECB|RC4|RC2)|mcrypt_|CryptoJS\.(MD5|SHA1|DES|RC4)" .
```
- **MD5 / SHA-1 / MD4 / DES / 3DES / RC4 / RC2 / Blowfish** for anything security-relevant = weak (CWE-327/328).
- **ECB mode** leaks plaintext patterns; any block cipher in ECB with real data = finding. **CBC without an authenticated MAC / no integrity** → padding-oracle risk (CWE-327).
- Node `crypto.createCipher()` (no IV, weak key derivation) is deprecated and unsafe — flag it; the safe API is `createCipheriv()` with a random IV.

## 2. Weak password / key-derivation hashing — CWE-916 (class `crypto` · ASVS V2.4)
Passwords must use a **memory-hard / slow KDF**: bcrypt, scrypt, Argon2, or PBKDF2 (high iteration). A plain/fast hash (MD5, SHA-1, SHA-256, even salted) for passwords = CWE-916.
```bash
rg -n -i "password|passwd|pwd|credential" -l | xargs -r rg -n -i "hashlib\.(md5|sha1|sha256)|createHash|MessageDigest|digest\(" 2>/dev/null
rg -n -i "bcrypt|scrypt|argon2|pbkdf2|password_hash\(|BCryptPasswordEncoder|Argon2" .   # confirm a SAFE KDF is PRESENT
```
Verify by *absence*: if the password path hashes with a fast digest and no bcrypt/scrypt/argon2/PBKDF2 appears, it's a finding.

## 3. Static / hardcoded IV, key, or salt — CWE-329/330 (class `crypto` · ASVS V6.2)
```bash
rg -n -i "iv ?= ?[\"'b]|IvParameterSpec\(|SecretKeySpec\(|new byte\[\s*(8|16|12|32)\s*\]|nonce ?=|salt ?= ?[\"']|createCipheriv\(|GCMParameterSpec\(" .
```
Verify the IV/nonce is **random per message** (not a constant, zero buffer, or counter reused across keys) and keys/salts aren't literal in source (cross-ref `review-secrets`). A reused static IV/nonce with CBC/CTR/GCM is exploitable (GCM nonce reuse is catastrophic).

## 4. Insecure randomness — CWE-330/338 (class `crypto` · ASVS V6.3 · WSTG-CRYP-06)
```bash
rg -n "Math\.random\(|new Random\(|java\.util\.Random|random\.(random|randint|choice|randrange|shuffle)\(|\brand\(|mt_rand\(|srand\(|uniqid\(|uuid1\(|math/rand|time\.Now\(\)\.Unix" .
```
`Math.random()`, `java.util.Random`, Python `random.*`, PHP `rand()`/`mt_rand()`/`uniqid()`, Go `math/rand`, `uuid1()`, and timestamp-seeded values are **not** cryptographically secure. Using them for **tokens, session ids, password-reset codes, OTPs, API keys, CSRF tokens, nonces, or salts** = predictable-token finding. Safe: `crypto.randomBytes`, `secrets.token_*` / `os.urandom`, `java.security.SecureRandom`, `random_bytes()`, Go `crypto/rand`.
```js
// VULNERABLE — guessable reset token
const token = Math.random().toString(36).slice(2)
// SAFE
const token = require('crypto').randomBytes(32).toString('hex')
```

## 5. TLS / certificate verification disabled — CWE-295 (class `crypto` · ASVS V9 · WSTG-CRYP-01)
```bash
rg -n -i "verify ?= ?False|rejectUnauthorized ?: ?false|InsecureSkipVerify ?: ?true|CURLOPT_SSL_VERIFYPEER.{0,4}(0|false)|CURLOPT_SSL_VERIFYHOST.{0,4}0|NODE_TLS_REJECT_UNAUTHORIZED|TrustAllCerts|trustAllCerts|checkServerIdentity ?: ?\(\)|ALLOW_ALL_HOSTNAME|_create_unverified_context|X509TrustManager|HostnameVerifier|setHostnameVerifier|verify_mode ?= ?CERT_NONE" .
```
Disabled cert/hostname verification on outbound TLS = MITM exposure. An empty `X509TrustManager`/`HostnameVerifier` that returns true is the Java form. Verify it's on a real network client (not a test harness) before setting high severity — but keep it as a finding either way.

## 6. Sensitive data in logs / URLs / errors — CWE-532/598/209 (class `logging`)
```bash
rg -n -i "(log|logger|console\.(log|error|info)|print|printf|fmt\.Print|System\.out|Rails\.logger)\b.{0,40}(password|passwd|secret|token|api[_-]?key|authorization|cookie|session|ssn|card|cvv|pan)" .
rg -n -i "\?(.*&)?(token|password|api_key|access_token|sessionid)=" .      # secrets in query strings get logged/cached/proxied
```
Logging a credential/token/PII, or putting a secret in a URL query (ends up in access logs, proxies, browser history, referrers) = sensitive-data-exposure. **Record log/error leakage under class `logging` (CWE-532/209); data-at-rest/in-transit exposure under class `crypto` (CWE-311/312/319).**

## 7. Other sensitive-data & side-channel pitfalls
- Sensitive data stored or transmitted in plaintext (CWE-311/312/319); PII/secrets/stack traces returned in error responses (CWE-209).
- **Non-constant-time comparison** of secrets/tokens/HMACs (`==` / `.equals` instead of `hmac.compare_digest` / `crypto.timingSafeEqual` / `MessageDigest.isEqual`) — timing side channel (CWE-208).
```bash
rg -n "==.*(hmac|signature|token|mac|digest)|\.equals\(.*(hmac|token|signature)|compare_digest|timingSafeEqual|MessageDigest\.isEqual" .
```

## 8. Wire into the loop
```
record kind=hypothesis statement="password reset token uses Math.random" target=auth/reset.js class=crypto approach="read token generation" outcome=testing
record kind=finding title="Predictable password-reset token (Math.random)" severity=high target=auth/reset.js:31 class=crypto cwe=CWE-330 description="reset token from Math.random(), not CSPRNG" repro="tokens are guessable/brute-forceable; see auth/reset.js:31" evidence=["auth/reset.js:31"] status=confirmed
```
Severity: predictable auth tokens / password stored with fast hash / disabled TLS verify = high; ECB / static IV / GCM nonce reuse = medium–high by data sensitivity; secret in logs = medium. Refute only when a CSPRNG / strong KDF / authenticated cipher / real cert check is actually in the path; keep unresolved cases `outcome=inconclusive`.

## References
- OWASP Cryptographic Storage Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Cryptographic_Storage_Cheat_Sheet.html
- OWASP Password Storage Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Password_Storage_Cheat_Sheet.html
- OWASP Logging Cheat Sheet — https://cheatsheetseries.owasp.org/cheatsheets/Logging_Cheat_Sheet.html
- MITRE CWE-327 Use of a Broken or Risky Cryptographic Algorithm — https://cwe.mitre.org/data/definitions/327.html
- MITRE CWE-916 Use of Password Hash With Insufficient Computational Effort — https://cwe.mitre.org/data/definitions/916.html
- MITRE CWE-330 Use of Insufficiently Random Values — https://cwe.mitre.org/data/definitions/330.html
- OWASP Top 10 2021 A02 Cryptographic Failures — https://owasp.org/Top10/A02_2021-Cryptographic_Failures/
