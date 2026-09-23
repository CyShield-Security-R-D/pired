# Theme

pired ships one theme, called `pired`. It is a dark theme with subdued blue controls and activity indicators. Red marks errors, critical findings and the wordmark; ordinary prompts no longer look like failures.

```bash
pired              # loads the theme
pired --no-theme   # keep whatever pi theme you already use
```

The theme is a normal pi theme file (`themes/pired.json`) against pi's theme schema. Nothing about pired requires it — every colour in the UI is resolved through the active theme's roles, so pired looks correct under any theme you prefer.

## The palette

| Var | Hex | Used for |
|---|---|---|
| `blue` | `#88c0d0` | accent, active borders, links, inline code, spinner |
| `blueBright` | `#b4dbe5` | higher thinking levels |
| `red` | `#ff5f5f` | errors, removed diff lines, the `red` half of the wordmark |
| `text` | `#dcdcdc` | body text |
| `gray` | `#98a2ad` | muted, thinking text, tool output |
| `dimGray` | `#80868f` | secondary labels and structural chrome |
| `darkGray` | `#46505d` | borders and rules |
| `selectedBg` | `#303843` | selected rows and search matches |
| `green` | `#a3be8c` | success, refuted hypotheses, diff added |
| `yellow` | `#e5c07b` | warning, medium severity, numbers |

The wordmark remains `pi` (dim) + `red` (red). Normal interaction uses blue independently of the brand, while muted labels have enough contrast to remain readable on the dark background.

## How colour is used

Use separate roles for normal interaction, severity and outcome. Structural elements use neutral grays.

| Role | Where you see it |
|---|---|
| `error` | critical and high findings, vulnerable cells, an unauthorized gate |
| `warning` | medium findings, blocked cells, `warn` mode, blockers |
| `success` | clear cells, refuted hypotheses |
| `accent` | active controls, the engagement, an armed gate, the coverage bar, the spinner |
| `dim` | every rule, border, label, and separator in the interface |

Normal activity is visually distinct from warnings and failures. Labels and glyphs also carry state, so color is never the only signal.

## Using your own theme

Any pi theme works. pired asks pi to switch to `pired` only when the theme file was actually loaded — under `pi` alone, or with `--no-theme`, the call is a silent no-op and your theme stays.

To write your own, copy `themes/pired.json` and change the `vars`; the `colors` map is roles, not literals, so a palette swap is enough. Install it as any pi theme and select it with `/theme`.

Preserve the separation between `accent`, `success`, `warning`, and `error`. A theme that maps `success` and `error` to similar hues makes the coverage bar unreadable, since `●` clear and `▲` vulnerable are distinguished by colour as much as by glyph.

## Working indicator

The theme also carries the spinner: a braille cycle (`⠋⠙⠹⠸⠼⠴⠦⠧⠇⠏`) at 80 ms, inked in the accent. It is re-inked whenever the theme changes, so switching themes mid-session does not leave the old accent spinning.
