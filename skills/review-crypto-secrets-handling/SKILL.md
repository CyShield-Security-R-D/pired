---
name: review-crypto-secrets-handling
description: Use when reviewing crypto & sensitive-data handling — weak hashes/ciphers, static IV/keys, bad randomness, disabled TLS, secrets in logs. CWE-327/330/916.
---

# Cryptography & sensitive-data handling review

Goal: find broken or misused crypto and secrets that leak through side channels (logs, URLs). Source of risk is usually a *choice* (which algorithm/mode/RNG), not tainted input — so grep the primitive, then read how it's used.

Tools run via `bash` and may be absent — these are mostly grep + read. Save notes to `evidence/`.

## 1. Weak / broken algorithms — CWE-327 (class `crypto`)
```bash
rg -n -i "\bMD5\b|\bSHA1\b|\bDES\b|\bRC4\b|\bECB\b|createHash\(['\"]md5|MessageDigest\.getInstance\(\"MD5|hashlib\.(md5|sha1)|Cipher\.getInstance\(\"(DES|AES/ECB|RC4)" .
```
- **MD5/SHA1/DES/RC4** for anything security-relevant = weak.
- **Password hashing with a plain/fast hash** (MD5/SHA-256 no salt) instead of **bcrypt/scrypt/argon2/PBKDF2** = CWE-916. Grep `bcrypt|scrypt|argon2|pbkdf2` to confirm a safe KDF is *absent*.
- **ECB mode** leaks plaintext patterns; any block cipher in ECB with real data = finding.

## 2. Static / hardcoded IV, key, or salt — CWE-329/330
```bash
rg -n -i "iv ?= ?[\"'b]|IvParameterSpec\(|SecretKeySpec\(|new byte\[|nonce ?=|salt ?= ?[\"']|createCipheriv\(" .
```
Verify the IV/nonce is **random per message** (not a constant/zero buffer) and keys aren't literal in source (cross-ref `review-secrets`). A reused static IV with CBC/CTR/GCM is exploitable.

## 3. Insecure randomness — CWE-330/338
```bash
rg -n "Math\.random\(|new Random\(|random\.random\(|random\.randint|rand\(|mt_rand\(|uuid1\(" .
```
`Math.random()`, `java.util.Random`, Python `random`, PHP `rand()`/`mt_rand()` are **not** cryptographically secure. Using them for tokens, session ids, password-reset codes, OTPs, or nonces = predictable-token finding. Safe: `crypto.randomBytes`, `secrets.token_*`, `SecureRandom`, `random_bytes()`.
```js
// VULNERABLE — guessable reset token
const token = Math.random().toString(36).slice(2)
// SAFE
const token = require('crypto').randomBytes(32).toString('hex')
```

## 4. TLS / certificate verification disabled — CWE-295
```bash
rg -n -i "verify ?= ?False|rejectUnauthorized ?: ?false|InsecureSkipVerify ?: ?true|CURLOPT_SSL_VERIFYPEER.*0|NODE_TLS_REJECT_UNAUTHORIZED|TrustAllCerts|checkServerIdentity ?: ?\(\)|ALLOW_ALL_HOSTNAME" .
```
Disabled cert/hostname verification on outbound HTTPS = MITM exposure. Verify it's on a real network client (not a test harness) before recording.

## 5. Secrets in logs / URLs / errors — CWE-532/598
```bash
rg -n -i "(log|logger|console\.(log|error)|print|printf|System\.out)\b.*(password|passwd|secret|token|api[_-]?key|authorization|cookie|ssn|card)" .
rg -n -i "GET .*(token|password|api_key)=" .      # secrets in query strings get logged/cached
```
Logging a credential/token/PII, or putting a secret in a URL query (ends up in access logs, proxies, referrers) = sensitive-data-exposure finding.

## 6. Other sensitive-data pitfalls
- Sensitive data stored/compared in plaintext; PII/secrets in error responses or stack traces returned to users.
- Non-constant-time comparison of secrets/HMACs (`==` instead of `hmac.compare_digest`/`crypto.timingSafeEqual`/`MessageDigest.isEqual`) — timing side channel.

## 7. Wire into the loop
```
record kind=hypothesis statement="password reset token uses Math.random" target=auth/reset.js class=crypto approach="read token generation" outcome=testing
record kind=finding title="Predictable password-reset token (Math.random)" severity=high target=auth/reset.js:31 class=crypto cwe=CWE-330 description="reset token from Math.random(), not CSPRNG" repro="tokens are guessable/brute-forceable; see auth/reset.js:31" evidence=["auth/reset.js:31"] status=confirmed
```
Severity: predictable auth tokens / password stored with fast hash = high; disabled TLS verify = high; ECB/static IV = medium/high by data sensitivity; secret in logs = medium. Refute when a CSPRNG / strong KDF / real cert check is actually used.
