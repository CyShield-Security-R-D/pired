---
name: firmware-extract
description: Use to get from a firmware blob to an analysable root filesystem — identify, check for encryption, carve, and record what the image actually is.
---

# Getting the filesystem out of a firmware image

Goal: turn a `.bin` into a directory you can read, and record what you learned on the way. This is OWASP FSTM stages 3–4; everything downstream (`firmware-triage`, `firmware-binaries`, `firmware-emulate`) assumes it succeeded.

Nothing here touches a network, so the scope gate does not gate it — but an image is client property. Keep it and everything carved out of it inside the engagement workspace.

## 0. Frame it in the loop
- Record the image itself first: `record kind=host value=fw:<vendor>-<model>-<version>`. Every firmware cell hangs off it, and without it the coverage matrix has no rows.
- Record its hash. A firmware finding is worthless if nobody can tell which build it was found in — the version string plus a SHA-256 is what makes a re-test after the vendor's patch unambiguous.
- Save raw tool output to `$PIRED_WORKSPACE/evidence/`; carry only conclusions into context.

```bash
sha256sum firmware.bin | tee "$PIRED_WORKSPACE/evidence/image-hash.txt"
record kind=host value=fw:acme-cam-1.4.2
record kind=note text="firmware.bin sha256 <hash>, vendor portal, 2026-09-10"
```

## 1. What is this file?
```bash
file firmware.bin
binwalk firmware.bin | tee "$PIRED_WORKSPACE/evidence/binwalk-scan.txt"
binwalk -E firmware.bin            # entropy: a flat line near 1.0 means encrypted or already compressed
```
High, featureless entropy across the whole image means **encrypted or packed**, and no tool in this stack solves that automatically. Do not grind on it: park a blocker (`record kind=blocker blockerType=input question="firmware.bin looks encrypted — is there a plaintext image, or a key from the bootloader/UART?"`) and carry on with whatever else is in scope. Say so in the report; "the image was encrypted and could not be analysed statically" is a finding about the vendor's posture as much as a limit on yours.

## 2. Carve it
Two extractors, and they fail differently — try the other before concluding an image is unextractable.
```bash
binwalk -Me firmware.bin --log="$PIRED_WORKSPACE/evidence/binwalk-extract.log"
unblob -e "$PIRED_WORKSPACE/artifacts/unblob" firmware.bin
```
`binwalk` v3 is a Rust rewrite: `--dd`, `-W`, `-A` and the importable Python module are **gone**, so drive it through the CLI. `unblob` is chunk-based rather than signature-heuristic and needs no root.

Per-filesystem, when the generic pass leaves a blob behind:

| Filesystem | Tool | Invocation |
|---|---|---|
| SquashFS (incl. vendor-mangled) | `sasquatch` | `sasquatch -p 1 -d squashfs-root fs.squashfs` · `sasquatch-v4be` for big-endian v4 |
| JFFS2 | `jefferson` | `jefferson image.jffs2 -d out -f` |
| UBI / UBIFS | `ubi_reader` | `ubireader_extract_files -o out ubifs.img` |
| CramFS | util-linux | `fsck.cramfs -x out fs.cramfs` · `cramfsswap` first if the endianness is wrong |
| YAFFS2 | `unyaffs` / `yaffshiv` | thin tooling — the weak point of the whole ecosystem; expect to fall back to manual carving |

If a needed extractor is missing, `record kind=blocker blockerType=input question="install sasquatch?"` rather than declaring the image unextractable.

## 3. Record what came out
```bash
ROOT="$PIRED_WORKSPACE/artifacts/rootfs"
ls "$ROOT"                                    # sanity: bin sbin etc lib usr www
cat "$ROOT/etc/os-release" 2>/dev/null
"$ROOT/bin/busybox" 2>&1 | head -1            # version banner, even without running it
```
Record the platform as inventory, because these become the rows the CVE class is asked of:
```
record kind=tech name=busybox version=1.19.4
record kind=tech name=dropbear version=2012.55
record kind=tech name=linux-kernel version=2.6.36
```
Note the architecture and endianness (`file "$ROOT/bin/busybox"`) — `firmware-emulate` needs both, and `firmware-binaries` needs the arch to pick a disassembler.

## 4. Hand off
- Filesystem contents, secrets, startup scripts, web root → `firmware-triage`
- Binary hardening, CVEs by component, decompilation → `firmware-binaries`
- Getting it running → `firmware-emulate`

## References
- OWASP Firmware Security Testing Methodology (FSTM) — stages 3 and 4 — https://scriptingxss.gitbook.io/firmware-security-testing-methodology
- binwalk v3 — https://github.com/ReFirmLabs/binwalk
- unblob — https://github.com/onekey-sec/unblob
- sasquatch · jefferson · ubi_reader — https://github.com/onekey-sec
