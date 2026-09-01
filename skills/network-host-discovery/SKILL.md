---
name: network-host-discovery
description: Use to find live hosts and open ports on authorized IPs/CIDRs — staged fast sweep then targeted nmap -sV -sC — recording hosts/services into inventory.
---

# Host & port discovery

Goal: turn authorized IPs/CIDRs into a recorded inventory of **live hosts and their open ports/services**. Stage it: cheap/fast breadth first, then expensive/accurate depth only on what is live. **Recall over speed — a host or port you never scan is one you can never test.** Save raw scans to `evidence/`; record distilled hosts+services. This feeds `network-service-enum`.

Tools run via `bash` and may be missing. If absent: try an alternative below, else `record kind=note` the gap and `record kind=blocker blockerType=input question="install nmap/masscan?"` for a critical one. Never install heavy tooling unprompted.

## 0. Scope & safety first
- Scan **only** IPs/CIDRs in the authorized scope (`pired.scope.json` / `recall`). The scope gate blocks out-of-scope targets, but it is accident-prevention, not a sandbox — you are responsible for staying in-scope.
- Rate discipline: high `--min-rate`/masscan `--rate` can saturate links and trip IDS/IPS or knock over fragile hosts. Start moderate; only go fast when the operator confirms the network can take it.
- `-T5`, `--script` intrusive categories, and full-range UDP are noisy/heavy — reserve for authorized, get an `approval` blocker if the rules of engagement are unclear.
- Never run DoS-style or `--script dos` probes.

## 1. Alive-host sweep (breadth)
```bash
# nmap ping/discovery sweep, no port scan yet
nmap -sn -PE -PP -PS443,80,22 -PA3389 --min-rate 1000 10.10.20.0/24 -oA "$PIRED_WORKSPACE/evidence/hostsweep"
# fast alternative for big ranges:
fping -a -g 10.10.20.0/24 2>/dev/null | tee "$PIRED_WORKSPACE/evidence/alive_fping.txt"
# collect live IPs
grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' "$PIRED_WORKSPACE/evidence/hostsweep.gnmap" | sort -u > "$PIRED_WORKSPACE/evidence/live_ips.txt"
```
Note: hosts often drop ICMP but answer on TCP; **an empty ping sweep is not proof a range is dead.** Before concluding, do a light top-ports TCP scan (§2), or on a hardened segment scan the whole CIDR directly with `-Pn` (skip host discovery, treat every IP as up) so filtered-but-live hosts are not lost.

## 2. Fast port sweep (breadth, all live IPs)
Cover the **full 1-65535 TCP range** in the breadth pass — a top-ports sweep alone will miss services parked on odd ports (admin panels, DBs, backdoors love high ports). Use top-ports only as a first look, then widen.
```bash
# masscan: fast, whole-range, TCP SYN — tune --rate to the network
masscan -iL "$PIRED_WORKSPACE/evidence/live_ips.txt" -p1-65535 --rate 2000 -oL "$PIRED_WORKSPACE/evidence/masscan.txt"
# nmap-only alternative — first look (fast top ports), THEN full range so nothing is lost:
nmap -sS -T4 --top-ports 1000 --min-rate 1500 -iL "$PIRED_WORKSPACE/evidence/live_ips.txt" -oA "$PIRED_WORKSPACE/evidence/nmap_top" --open
nmap -sS -T4 -p- --min-rate 1500 -iL "$PIRED_WORKSPACE/evidence/live_ips.txt" -oA "$PIRED_WORKSPACE/evidence/nmap_allports" --open
# distill open host:port pairs (masscan -oL: "open <proto> <port> <ip> <ts>")
awk '/^open/{print $4":"$3}' "$PIRED_WORKSPACE/evidence/masscan.txt" | sort -u > "$PIRED_WORKSPACE/evidence/openports.txt"
```
`masscan` needs raw-socket privileges (root/cap_net_raw); if it errors on permissions, `record kind=blocker` asking the operator, or fall back to nmap `-sT` (TCP connect scan, no privileges — slower but complete). masscan can drop packets at high `--rate`; on a critical target re-confirm with an nmap `-p-` pass rather than trusting a single fast sweep.

## 3. Targeted service/version + default scripts (depth)
Only on the open ports found above — this is the slow, accurate pass:
```bash
# feed masscan's open ports back into nmap for -sV -sC on exactly those ports
ports=$(awk '/^open/{print $3}' "$PIRED_WORKSPACE/evidence/masscan.txt" | sort -un | paste -sd,)
nmap -sV -sC -p"$ports" --min-rate 1000 -iL "$PIRED_WORKSPACE/evidence/live_ips.txt" -oA "$PIRED_WORKSPACE/evidence/nmap_sv"
# or per-host full detail:
nmap -sV -sC -O -p- --min-rate 2000 -oA "$PIRED_WORKSPACE/evidence/nmap_HOST" 10.10.20.7
```
- `-sV` confirms the actual service (don't trust the port number — 8080 may be anything). Add `--version-all` (`-sV --version-intensity 9`) on a stubborn/unknown port before calling it unidentified.
- `-sC` runs the *safe* default script category; add targeted `--script` per service in `network-service-enum`, not blanket intrusive scripts here.
- `-O` (OS detection) needs raw sockets.
- A port that stays `open` in `-sV` but returns no version banner is still a lead — record the service as `name=unknown` and hand it to `network-service-enum` for a protocol-specific probe. Do not silently drop it.

## 4. UDP notes (selective, slow) — where misses hide
UDP scans are slow and lossy, but skipping UDP entirely loses whole services (DNS, SNMP, TFTP, IKE, NetBIOS). Don't blanket `-sU -p-`; target the high-value UDP ports and confirm with a real probe.
```bash
nmap -sU -sV --top-ports 100 --min-rate 800 -oA "$PIRED_WORKSPACE/evidence/nmap_udp" 10.10.20.7
# key ports: 53 DNS, 67/68 DHCP, 69 TFTP, 123 NTP, 137/138 NetBIOS, 161/162 SNMP,
#            500 IKE/VPN, 514 syslog, 623 IPMI, 1900 SSDP, 5353 mDNS
```
`open|filtered` UDP is common and ambiguous — a non-response reads the same as a silent-open service. Never conclude "closed" from that state: confirm the high-value ones with a service-specific probe (`snmpwalk`/`onesixtyone` for 161, `dig @host` for 53, `ike-scan` for 500). If a probe is inconclusive, record it as a hypothesis with `outcome=inconclusive` rather than dropping it.

## 5. Record the surface
```
record kind=host value=10.10.20.7 ip=10.10.20.7 tech=["Windows Server 2019"]
record kind=service host=h1 port=445 proto=tcp name=microsoft-ds
record kind=service host=h1 port=3389 proto=tcp name=ms-wbt-server
record kind=service host=h1 port=161 proto=udp name=snmp
record kind=note text="Subnet 10.10.20.0/24: 6 live hosts, SMB+RDP cluster on .7/.8, web on .10; 3 hosts drop ICMP (found via -Pn -p-)"
```
- Record **every** host once (use its id as `host=` on services), one service record per open port — TCP and UDP alike. An unrecorded service cannot be enumerated or show up in `recall gaps`.
- Record uncertain surface too: an unidentified port, an `open|filtered` UDP service, or a host that only answered `-Pn` is still a lead — record it (service `name=unknown`, or a note) so it is not lost.
- Confirm before recording as fact: a version banner can be spoofed/wrong — for anything you'll act on, verify with a protocol-specific probe in `network-service-enum`.
- When hosts+services are in inventory, run `recall coverage`/`recall gaps`, then move to `network-service-enum` to enumerate each service and seed hypotheses.

## References
- PTES — Intelligence Gathering (network/port scanning) — Penetration Testing Execution Standard (pentest-standard.org; link omitted, site not fetch-verifiable this session)
- NIST SP 800-115, Technical Guide to Information Security Testing and Assessment (§4 Target Identification, network discovery/port scanning) — https://csrc.nist.gov/pubs/sp/800/115/final
- Nmap Reference Guide — host discovery & port-scan options (`-sn`, `-Pn`, `-sS`, `-sT`, `-sU`, `-sV`, `-sC`, `-p-`, `--top-ports`, `--min-rate`) — https://nmap.org/book/man.html
- Masscan documentation (`-p`, `--rate`, `-oL`, `-iL`) — https://github.com/robertdavidgraham/masscan
