---
name: firmware-emulate
description: Use to get firmware running without the hardware — qemu-user for one binary, FirmAE for a whole device — and to tell a real crash from an emulation artifact.
---

# Emulating firmware

Goal: reach the point where the device's own web interface answers a request, so the `cmdi` / `authbypass` / `traversal` hypotheses from `firmware-triage` can be *proven* rather than argued from decompilation. OWASP FSTM stages 6–7.

**Expect this to fail sometimes, and budget for it.** On the same 1,124-image corpus, firmadyne reached a working web service on **16%** of images; FirmAE, which adds NVRAM and ioctl arbitration, reached **79%**. That is the honest range. An image that will not boot is not a dead end — static findings still stand, and "could not be dynamically confirmed because the image would not emulate" is a legitimate, expected caveat in a rigorous report. It is not a reason to quietly upgrade a static hit to `confirmed`.

## 0. Scope, before anything listens
Emulation puts a service on a port on *this* box. That is the one part of firmware work the scope gate sees: `curl` against it is a gated network command.
- Under `review` (gate off) it just works.
- Under `pentest` in `enforce`, `127.0.0.1` must be in the scope's targets or your own probes are blocked. Check with `recall status` before spending an hour booting something you cannot then talk to.
- Never point an emulated device at the client's real cloud endpoint. It will phone home with real credentials from the image.

## 1. One binary — qemu-user
Fastest path when you only need a specific CGI handler to run.
```bash
ROOT="$PIRED_WORKSPACE/artifacts/rootfs"
file "$ROOT/bin/busybox"                       # arch + endianness, from firmware-extract
cp "$(which qemu-mips-static)" "$ROOT/"
sudo chroot "$ROOT" ./qemu-mips-static /bin/busybox sh
# dynamically linked, without a chroot:
QEMU_LD_PREFIX="$ROOT" qemu-mips-static "$ROOT/usr/sbin/httpd" -f
```
Where it breaks: unimplemented syscalls and ioctls for the target arch; a dynamically-linked binary failing silently without `QEMU_LD_PREFIX`; and anything that talks to another process — shared memory, Unix sockets, an nvram helper — because only the one binary is emulated. Multi-process IPC is precisely the gap full-system emulation exists to close.

## 2. The whole device — FirmAE
```bash
sudo ./run.sh -c acme firmware.bin      # check: does it boot and serve?
sudo ./run.sh -r acme firmware.bin      # run it and keep it up
```
Use **FirmAE**, not firmadyne — firmadyne has had no push since mid-2024 and FirmAE is its maintained successor with roughly 4.8× the boot rate. Both need root (TAP networking, chroot, loop mounts), so this is the step to run in a VM or a disposable container rather than on your working box.

When it will not boot, the causes are a short list:
- **NVRAM** — `nvram_get()` returning NULL crashes init scripts that assume a string. FirmAE arbitrates to empty-string instead, which is most of its improvement.
- **Missing peripherals** — GPIO, LEDs and watchdogs are often driven from userspace, so there is nothing for a generic kernel shim to intercept.
- **Watchdog reboot loops** — the image reboots itself every few seconds because nothing is petting the watchdog.
- **Kernel mismatch** — the emulator picks from a small pre-built kernel set, not the vendor's actual kernel.

Park a `note` saying which one you hit. It is useful in the report and it saves the next person the same hour.

## 3. Prove the hypotheses
Once it answers, the `firmware-triage` hypotheses become ordinary web testing — hand off to `web-injection`, `web-access-control`, `web-file-path`. The one thing to keep firmware-specific is **the control case**, because a challenge will demand it:
```bash
# blind command injection: the timing control is what separates it from reflection
time curl -s "http://127.0.0.1:8080/cgi-bin/admin?cmd=;sleep 9" -o /dev/null
time curl -s "http://127.0.0.1:8080/cgi-bin/admin?cmd=;sleep 0" -o /dev/null
```
Capture both to `$PIRED_WORKSPACE/evidence/` — the payload *and* the control, in one file, with the responses. Output that merely contains the payload string is reflection, and `recall challenge` will say so and refuse to promote the finding.

## 4. Triaging a crash
A crash under emulation is **not** automatically a `memory-safety` finding. QEMU-based rehosting produces false crashes from missing peripherals and wrong NVRAM values often enough that a human has to separate them. Before recording anything above `suspected`:
- Does it crash the same way twice, from the same input?
- Does a benign input of the same length and shape *not* crash it?
- Is the faulting address plausibly derived from your input, or is it an unimplemented ioctl?

If you cannot answer those, record `outcome=inconclusive` with what you tried. That is a real result and it survives; a `confirmed` overflow that was an emulator artifact is the kind of thing a client's engineer disproves in ten minutes.

## References
- OWASP FSTM stages 6–7 — https://scriptingxss.gitbook.io/firmware-security-testing-methodology
- FirmAE, ACSAC 2020 — 79.36% vs firmadyne's 16.28% on 1,124 images — https://dl.acm.org/doi/fullHtml/10.1145/3427228.3427294
- FirmAE — https://github.com/pr0v3rbs/FirmAE
- Qiling (scriptable userspace emulation, when qemu-user is too blunt) — https://github.com/qilingframework/qiling
