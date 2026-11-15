# Contributing

Read these before changing anything:

- [`CLAUDE.md`](CLAUDE.md) — the working notes: the one structural rule (`core/` imports nothing),
  where logic belongs, and how tests are written. They apply to people as much as to agents.
- [`docs/decisions.md`](docs/decisions.md) — the architecture decisions, including what was
  rejected and why. Add an entry when you make a decision a later reader would otherwise
  re-litigate, and cite its ADR number in the commit.
- [`docs/architecture.md`](docs/architecture.md) and [`FORMAT.md`](FORMAT.md) — the shape of the
  code and the on-disk ledger format.

## Before you open a pull request

```bash
npm ci
npm run check    # typecheck + tests + coverage ratchets + the eval assay
```

The coverage thresholds are floors set just under what is measured today, so `check` fails when
coverage goes backwards. A change that drops coverage needs tests, not a lower floor.

Node.js 22.19 or later is required.

## Issues

pired is used on client engagements. **Never paste client code, hostnames, findings or ledger
content into an issue**, even redacted by eye — describe the shape of the input instead. To report a
vulnerability in pired itself, follow [SECURITY.md](SECURITY.md), not the issue tracker.

## The eval scripts

Several scripts under `eval/` delete and recreate engagement directories under `~/.pired` and stop
`pi` processes. Run them only as a throwaway user, in a container or VM — see
[`eval/README.md`](eval/README.md).
