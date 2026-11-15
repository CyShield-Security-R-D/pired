# Security policy

pired drives security tools against systems its operator is authorized to test. A flaw in pired can
therefore reach a client's systems or a client's data, which is why the cases below are treated as
vulnerabilities even where the README calls a mechanism accident prevention rather than a boundary.

## Reporting

Report privately through GitHub: **Security → Report a vulnerability** on this repository. Please do
not open a public issue for a vulnerability.

Include the pired commit, the pi version, the OS, and the smallest reproduction you can. **Do not
include client code, hostnames, findings or ledger content** — describe the shape of the input
instead.

pired has one maintainer. Reports are answered on a best-effort basis, and fixes land on `main`;
there are no tagged releases yet, so the latest commit on `main` is the only supported version.

## In scope

- **Scope gate:** a call whose target is in plain sight — a URL, host or IP the rules in
  [`docs/scope.md`](docs/scope.md#what-the-gate-sees) read — reaching an out-of-scope or excluded
  target. A call built to hide its target (shell tricks, encoding, an unusual tool) defeats the gate
  whoever wrote it, the operator or a target's content steering the agent; that is the documented
  limit, not a vulnerability.
- **Redaction:** a secret recorded as loot appearing unmasked in a `/report` export
  ([`docs/scope.md`](docs/scope.md#redaction)).
- **Workspace isolation:** one engagement's ledger read or written by another, or pired's own
  workspace, ledger or export code writing into the target's tree.
- **Installers:** anything in `install.sh` or `install.ps1` that runs code it did not show in its
  plan, or that weakens a checksum or signature check.

## Out of scope

- **Vulnerabilities pired finds in the systems it tests.** Report those to the system's owner or
  maintainers, not here.
- **pi, pi-subagents and pi-mcp-adapter.** Report those upstream; pired loads them but does not
  ship them.
- **The scope gate failing against a call built to hide its target.** The real boundary is the
  container or VM the engagement runs in ([Security & authorized use](README.md#security--authorized-use)).
