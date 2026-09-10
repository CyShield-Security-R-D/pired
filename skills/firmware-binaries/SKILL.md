---
name: firmware-binaries
description: Use on binaries from an extracted rootfs — component CVEs, exploit-mitigation hardening, and decompiling the handler that matters. Includes why version matching lies.
---

# Binaries and components in a firmware image

Goal: work out what the compiled parts of the image are, whether they are old, whether they are hardened, and what the interesting ones actually do. Covers `outdated-components`, `memory-safety`, `weak-rng`, `risky-crypto`.

`ROOT="$PIRED_WORKSPACE/artifacts/rootfs"`.

## 0. The caveat that governs this whole skill
**Every CVE hit from every tool below is a lead, not a finding.** Version identification on embedded binaries works by reading banner strings and matching patterns, and that is defeated routinely by:
- **Vendor backports** — the fix is applied, the version string is not bumped. The scanner reports a CVE that was patched two years ago.
- **Stripping and static linking** against uClibc/musl, which removes the symbols signatures match on.
- **Third-party SDK code compiled in but unreachable** from any input path in this product.

Industry SAST false-positive rates run 64–82%, and no firmware CVE tool publishes a measured rate at all. EMBA carries verifier modules — checking whether a flagged BusyBox applet is actually *present* — precisely because raw string matching is known unreliable.

So: record a CVE hit as `hypothesis outcome=inconclusive` or a `suspected` finding, and say what would settle it. Promote only when you can show the vulnerable code path is present and reachable. A report full of unverified version-match CVEs is the thing that makes clients stop reading firmware reports.

## 1. Inventory the components (`outdated-components`)
```bash
cve-bin-tool -f csv -o "$PIRED_WORKSPACE/evidence/cve-bin-tool.csv" "$ROOT"
syft dir:"$ROOT" -o cyclonedx-json="$PIRED_WORKSPACE/artifacts/sbom.json"
grype sbom:"$PIRED_WORKSPACE/artifacts/sbom.json"
```
`syft`'s binary classifier covers a *narrow* curated set — BusyBox, OpenSSL, Python, Go, and a handful more. It has **no classifier for dropbear, uClibc, musl, lighttpd/thttpd** or any vendor CGI binary, which is most of a router's actual attack surface. Do not read a quiet `syft` as a clean image. It also has a confirmed version-parsing bug on OpenSSL letter releases (reporting `1.1.1` for `1.1.1w`), which is exactly the library most embedded images carry.

Record each component as `record kind=tech name=<x> version=<y>`, then let `recall gaps` ask `outdated-components` of each. That is the point of recording them as surface: the matrix does the bookkeeping.

## 2. Hardening (`memory-safety` context)
```bash
checksec --file="$ROOT/usr/sbin/httpd" --output=json
find "$ROOT" -type f -executable -exec sh -c 'checksec --file="$1" --output=json' _ {} \; \
  > "$PIRED_WORKSPACE/evidence/checksec-all.json"
```
`checksec` is architecture-independent by construction — it reads `PT_GNU_STACK`, `e_type`, `PT_GNU_RELRO` and the `__stack_chk_fail` symbol, none of which is x86-specific — so it works on MIPS and ARM unchanged. Point `--libc` at the image's own libc for the Fortify check.

Missing NX/PIE/RELRO/canary is **not a finding on its own** — there is no CWE for "unhardened binary" and a client cannot act on a list of missing flags. It is severity context: the same overflow that is a crash on a hardened desktop binary is reliable code execution on a statically-linked MIPS CGI with no canary and no ASLR. Record it as a `note` against the binary and cite it in the impact paragraph of any `memory-safety` finding.

## 3. Decompile the ones that matter
Spend this on the handlers §2 of `firmware-triage` flagged, not on the whole rootfs.
```bash
# scriptable, multi-arch, free
analyzeHeadless "$PIRED_WORKSPACE/artifacts/ghidra" fw -import "$ROOT/usr/sbin/httpd" \
  -postScript FindSinks.py -deleteProject
rizin -A -q -c 'aa; afl' "$ROOT/usr/sbin/httpd"          # or radare2, same idea
cwe_checker "$ROOT/usr/sbin/httpd"                        # multi-arch CWE patterns, Ghidra-backed
```
`capa` does **not** work here — it is x86/x64 only, the ARM support PR is unmerged and MIPS was never attempted. Do not route embedded binaries through it and read the empty result as clean.

`angr` is worth it for one flagged function, not for a blanket sweep: its `CFGFast` heuristics are tuned for x86-64 and stripped MIPS/ARM binaries routinely need manual hints.

What a proven finding looks like at this layer — the published TP-Link case is the model: name the function, show the call, quote the literal.
```
snprintf(buf, 200, "uci set webserver.user_config.language=%s;uci commit webserver", lang);
... popen(buf, "r");
```
That, plus the file path inside the rootfs and the request that reaches it, is a finding. A decompiler screenshot with "looks vulnerable" is not.

## 4. Crypto and randomness (`risky-crypto`, `weak-rng`)
```bash
strings "$ROOT/usr/sbin/httpd" | grep -iE 'srand|rand\(|time\(NULL\)|MD5|DES|RC4|ECB' | head
```
`srand(time(NULL))` seeding a session token or a key is `weak-rng` (CWE-338) — and it is disproportionately common on embedded targets because the kernel entropy pool is frequently uninitialised at the moment first-boot key generation runs. A hand-rolled cipher, or AES-ECB on structured data, is `risky-crypto`.

## References
- cve-bin-tool (now OpenSSF) — https://github.com/ossf/cve-bin-tool
- syft binary classifier limits — https://github.com/anchore/syft/issues/2681
- checksec — https://github.com/slimm609/checksec
- cwe_checker — https://github.com/fkie-cad/cwe_checker
- Ghidra headless — https://github.com/NationalSecurityAgency/ghidra
- capa's architecture limit — https://github.com/mandiant/capa/pull/1803
