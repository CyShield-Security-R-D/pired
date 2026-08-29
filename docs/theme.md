# Theme

pired ships one theme, called `pired`. It is a dark, red-accented theme built so that colour in the interface only ever carries meaning.

```bash
pired              # loads the theme
pired --no-theme   # keep whatever pi theme you already use
```

The theme is a normal pi theme file (`themes/pired.json`) against pi's theme schema. Nothing about pired requires it — every colour in the UI is resolved through the active theme's roles, so pired looks correct under any theme you prefer.

## The palette

| Var | Hex | Used for |
|---|---|---|
| `red` | `#ff5f5f` | accent, error, the `red` half of the wordmark, high-thinking |
| `redDim` | `#d75f5f` | keywords, inline code, the custom-message label |
| `text` | `#dcdcdc` | body text |
| `gray` | `#8a8a8a` | muted, thinking text, tool output |
| `dimGray` | `#6c6c6c` | dim — all structural chrome |
| `darkGray` | `#3a3a3a` | borders and rules |
| `green` | `#a3be8c` | success, refuted hypotheses, diff added |
| `yellow` | `#e5c07b` | warning, medium severity, numbers |

The accent is the signal colour, which is why the wordmark renders as `pi` (dim) + `red` (accent): the brand mark and the alert colour are the same colour on purpose.

## How colour is used

One rule, applied everywhere: **colour carries meaning only — severity and outcome — never decoration.** Everything structural is dim.

| Role | Where you see it |
|---|---|
| `error` | critical findings, vulnerable cells, an unauthorized gate |
| `warning` | high and medium findings, blocked cells, `warn` mode, blockers |
| `success` | clear cells, refuted hypotheses |
| `accent` | the engagement, an armed gate, the coverage bar, the spinner |
| `dim` | every rule, border, label, and separator in the interface |

This is what makes the panel scannable: the only saturated things on screen are the things that need a decision.

## Using your own theme

Any pi theme works. pired asks pi to switch to `pired` only when the theme file was actually loaded — under `pi` alone, or with `--no-theme`, the call is a silent no-op and your theme stays.

To write your own, copy `themes/pired.json` and change the `vars`; the `colors` map is roles, not literals, so a palette swap is enough. Install it as any pi theme and select it with `/theme`.

The one thing worth preserving is the meaning split above. A theme that maps `success` and `error` to similar hues makes the coverage bar unreadable, since `●` clear and `▲` vulnerable are distinguished by colour as much as by glyph.

## Working indicator

The theme also carries the spinner: a braille cycle (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) at 80 ms, inked in the accent. It is re-inked whenever the theme changes, so switching themes mid-session does not leave the old accent spinning.
