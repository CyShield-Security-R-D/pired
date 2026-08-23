---
name: network-host-discovery
description: Use to find live hosts and open ports on authorized IPs/CIDRs — staged fast sweep then targeted nmap -sV -sC — recording hosts/services into inventory.
---

# Host & port discovery

Goal: turn authorized IPs/CIDRs into a recorded inventory of **live hosts and their open ports/services**. Stage it: cheap/fast breadth first, then expensive/accurate depth only on what is live. Save raw scans to `evidence/`; record distilled hosts+services. This feeds `network-service-enum`.

Tools run via `bash` and may be missing. If absent: try an alternative below, else `record kind=note` the gap and `record kind=blocker blockerType=input question="install nmap/masscan?"` for a critical one. Never install heavy tooling unprompted.

## 0. Scope & safety first
- Scan **only** IPs/CIDRs in the authorized scope (`pired.scope.json` / `recall`). The scope gate blocks out-of-scope targets, but it is accident-prevention, not a sandbox — you are responsible for staying in-scope.
- Rate discipline: high `--min-rate`/masscan `--rate` can saturate links and trip IDS/IPS or knock over fragile hosts. Start moderate; only go fast when the operator confirms the network can take it.
- `-T5`, `--script` intrusive categories, and full-range UDP are noisy/heavy — reserve for authorized, get an `approval` blocker if the rules of engagement are unclear.
- Never run DoS-style or `--script dos` probes.

## 1. Alive-host sweep (breadth)
```bash
# nmap ping/discovery sweep, no port scan yet
nmap -sn -PE -PP -PS443,80,22 -PA3389 --min-rate 1000 10.10.20.0/24 -oA evidence/hostsweep
# fast alternative for big ranges:
fping -a -g 10.10.20.0/24 2>/dev/null | tee evidence/alive_fping.txt
# collect live IPs
grep -oE '([0-9]{1,3}\.){3}[0-9]{1,3}' evidence/hostsweep.gnmap | sort -u > evidence/live_ips.txt
```
Note: hosts often drop ICMP but answer on TCP; if a sweep looks empty, do a light top-ports TCP scan (§2) before concluding the range is dead.

## 2. Fast port sweep (breadth, all live IPs)
```bash
# masscan: fast, whole-range, TCP SYN — tune --rate to the network
masscan -iL evidence/live_ips.txt -p1-65535 --rate 2000 -oL evidence/masscan.txt
# nmap-only alternative (fast top ports across the subnet):
nmap -sS -T4 --top-ports 1000 --min-rate 1500 -iL evidence/live_ips.txt -oA evidence/nmap_fast --open
# distill open host:port pairs
awk '/open/{print $4":"$3}' evidence/masscan.txt | sort -u > evidence/openports.txt
```
`masscan` needs raw-socket privileges (root/cap_net_raw); if it errors on permissions, `record kind=blocker` asking the operator, or fall back to nmap `-sT` (connect scan, no privileges).

## 3. Targeted service/version + default scripts (depth)
Only on the open ports found above — this is the slow, accurate pass:
```bash
# feed masscan's open ports back into nmap for -sV -sC on exactly those ports
ports=$(awk '/open/{print $3}' evidence/masscan.txt | sort -u | paste -sd,)
nmap -sV -sC -p"$ports" --min-rate 1000 -iL evidence/live_ips.txt -oA evidence/nmap_sv
# or per-host full detail:
nmap -sV -sC -O -p- --min-rate 2000 -oA evidence/nmap_HOST 10.10.20.7
```
- `-sV` confirms the actual service (don't trust the port number — 8080 may be anything).
- `-sC` runs the *safe* default script category; add targeted `--script` per service in `network-service-enum`, not blanket intrusive scripts here.
- `-O` (OS detection) needs raw sockets.

## 4. UDP notes (selective, slow)
UDP scans are slow and lossy — do not blanket `-sU -p-`. Target the high-value UDP services:
```bash
nmap -sU -sV --top-ports 50 --min-rate 800 -oA evidence/nmap_udp 10.10.20.7
# key ports: 53 DNS, 161 SNMP, 123 NTP, 137/138 NetBIOS, 500 IKE, 69 TFTP, 1900 SSDP
```
Open|filtered UDP is common and ambiguous; confirm with a service-specific probe (e.g. `snmpwalk`, `dig @host`) rather than trusting the state.

## 5. Record the surface
```
record kind=host value=10.10.20.7 ip=10.10.20.7 tech=["Windows Server 2019"]
record kind=service host=h1 port=445 proto=tcp name=microsoft-ds
record kind=service host=h1 port=3389 proto=tcp name=ms-wbt-server
record kind=note text="Subnet 10.10.20.0/24: 6 live hosts, SMB+RDP cluster on .7/.8, web on .10"
```
- Record every host once (use its id as `host=` on services), one service record per open port.
- Confirm before recording: a version banner can be spoofed/wrong — for anything you'll act on, verify with a protocol-specific probe in `network-service-enum`.
- When hosts+services are in inventory, run `recall coverage`/`recall gaps`, then move to `network-service-enum` to enumerate each service and seed hypotheses.
