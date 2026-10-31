# Models

Model selection is **pi's** — `/model`, or `Ctrl+P` to cycle. pired does not replace the picker; it adds to it.

What pired contributes is `~/.pired/models.json`: any OpenAI-compatible provider — LM Studio, Ollama, llama.cpp, OpenRouter, vLLM, a corporate proxy — registered into pi's own picker alongside your built-in and subscription models.

## Adding a provider

Open **`/provider add`**, choose a preset, and fill in one form. LM Studio,
Ollama, llama.cpp, vLLM and OpenRouter have defaults; choose **Other
OpenAI-compatible host** for a custom endpoint.

```text
Add provider
  Name          LM Studio
  Base URL      http://localhost:1234/v1
  API token     Optional · paste a key or $ENV_VAR
  Model IDs     qwen3, llama3
  Find models
  Manage models (2) · select, edit or remove
  ▸ Advanced · provider ID and API format
  [x] Use first model after saving
  Save provider
  Cancel
```

**Tab / Shift+Tab** or **↑ / ↓** moves between fields. Edit values directly,
then choose **Save provider** or press **Ctrl+S**. **Esc** goes back; leaving a
changed provider asks whether to discard the draft. No field is saved on its own.

- Local server presets need no token. For a hosted endpoint, paste its key or
  an environment reference such as `$OPENROUTER_KEY`. Keys stay masked, including
  while editing. Clearing a key restores unauthenticated local-server access.
- Paste several model IDs at once, separated by commas, spaces or newlines.
  Duplicate IDs are removed automatically.
- **Find models** asks the server for its model list. Search within the list,
  use **Space** or **Enter** to select models, or **Select all matching** to add
  a whole group. The list scrolls, and filtering keeps selections from other
  searches. A failed lookup leaves the form intact so you can correct the URL
  or enter model IDs manually.
- **Manage models** opens the same selection list without a network request.
  Deselect a model to remove it. Highlight one and press **e** to edit its
  context window, output limit, reasoning format and image support together.
  **Apply to draft** returns to the list; the provider's Save writes the changes.
- **Advanced** exposes the provider ID and API format. Presets use the
  OpenAI-compatible chat API. Press Enter on API format to cycle through the
  supported adapters. Existing provider IDs stay fixed; their display names
  can be edited. Adding the same preset again gets a separate ID.

The probe supplies model metadata when available; otherwise pired uses defaults
and infers reasoning from the model ID. Model rows show those settings so they
can be reviewed before saving. See [compatibility](#compat-and-the-failure-it-prevents)
when a server needs a specific reasoning format.

Save writes `~/.pired/models.json` with owner-only permissions, updates pi's
`~/.pi/agent/models.json` mirror, and registers the models immediately in `/model`.
**Use first model after saving** is checked for new providers; turn it off to
keep using your current model. Normal fields and borders use neutral colors;
red identifies validation errors and Delete.

## Editing or deleting a provider

**`/provider`** lists configured providers, with their URLs and model counts,
and an **Add provider** action. On first use it goes straight to the presets.
Choose a provider to open the same form used for adding one. **Delete provider**
asks for confirmation before removing it from both files and the session picker;
**Keep provider** is the default. An already active model stays until restart.

```text
/provider             open the manager
/provider add         add a provider directly
/provider edit <id>   edit a provider directly
/provider list        show configured providers and model IDs
/provider remove <id> delete one, with confirmation in the terminal
```

`/login` still includes **Add a custom provider…**, and `/login add-provider`
opens its callback-based wizard. Older hosts without custom terminal components
also use the dialog fallback. The form is the primary `/provider` interface.
The configuration remains plain JSON and can still be edited by hand.

## Why local models are the default case

A consultant under NDA often *cannot* paste client source into a frontier API. That is a contract term, not a preference.

So pired is tuned for ~30B open-weight models running on the engagement box, and the benchmark is built around that constraint: pired + Qwen3.8 27B locally reached **0.74 recall** against 0.68 for a frontier agent on the same target, with 100% critical recall — the lift coming from the security-tuned prompt rather than from model size. See [Evaluation](evaluation.md).

Frontier and subscription models work fine too, wherever the engagement allows them. Nothing in pired assumes a local model.

## `~/.pired/models.json`

What the manager writes, and what you can write yourself:

```jsonc
{
  "providers": [
    {
      "id": "lmstudio",
      "name": "LM Studio",
      "baseUrl": "http://localhost:1234/v1",
      "models": [
        { "id": "qwen3.8-27b", "contextWindow": 262144, "reasoning": true }
      ],
      "compat": { "thinkingFormat": "qwen" }
    },
    {
      "id": "openrouter",
      "baseUrl": "https://openrouter.ai/api/v1",
      "apiKey": "sk-or-…",
      "models": [
        { "id": "qwen/qwen3.8-27b", "contextWindow": 1000000, "reasoning": true }
      ]
    }
  ]
}
```

Then:

```bash
pired --provider lmstudio --model qwen3.8-27b
```

or start `pired` and pick from `/model`.

### Provider fields

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Provider id, used by `--provider`. |
| `baseUrl` | required | OpenAI-compatible endpoint. |
| `name` | `id` | Display name in the picker. |
| `apiKey` | `"local"` | Sent as the bearer token. `$VAR` / `${VAR}` is read from the environment instead of stored. |
| `api` | `openai-completions` | pi's API adapter. |
| `compat` | — | Compatibility switches; see below. |
| `contextGuard` | `true` | Reserve output and safety headroom for `openai-completions` and `openai-responses` requests while pired is loaded. |
| `models[]` | required | The models this provider serves. |

### Model fields

| Field | Default | Meaning |
|---|---|---|
| `id` | required | Model id as the server expects it. |
| `name` | `id` | Display name. |
| `contextWindow` | `32768` | Tokens. |
| `maxTokens` | `8192` | Max output tokens. |
| `reasoning` | `false` | Whether the model emits reasoning. |
| `input` | `["text"]` | Add `"image"` for vision. |
| `compat` | inherits provider's | Per-model override. |

A malformed or missing file is silently ignored — pired simply contributes no providers.

The file holds tokens, so pired writes it `0600` and repairs the mode of a file that was created world-readable before. Keeping a key out of it entirely is what `$ENV_VAR` is for.

## Context headroom and gateway errors

A model's context window includes **input plus output**, not just conversation
history. With `contextWindow: 262144` and `maxTokens: 32768`, at most 229,376
tokens remain for input before allowing for any safety margin.

For providers registered from `~/.pired/models.json` using
`openai-completions` or `openai-responses`, pired checks each request before
HTTP. It budgets the requested output plus a safety margin of
`min(16384, contextWindow / 16)` (rounded down, at least one token). With the
limits above, pired asks pi to compact at **212,992 input tokens**, including
new tool results. It leaves the advertised window and your global pi settings
unchanged.

Input is counted from the server's own usage for everything it has already
seen, plus an upper bound for what it has not: each new message is charged its
UTF-8 size, because a byte-level BPE token never covers less than one byte.
pi's own chars/4 estimate is not a bound. Measured through Bifrost to SGLang,
each 48,002-byte file of scanner-like output (hex dumps, hashed tokens,
minified JS) added 34,072–34,764 tokens where chars/4 gives 12,000, and plain
pi sent a request past the window while its footer read 84%. The bound can
compact up to one tool result early on prose; on that dense output it stopped a
request that, by the measured per-file cost, would have been about 210,700
tokens against the 212,992 budget.
A context with no usage to anchor to — the first request, the first after a
summary, and the summary request itself — is estimated instead, so a long
summary is not refused for its own size.

The guard emits a local `context_length_exceeded` error that pi recognizes.
With auto-compaction enabled, pi owns the summary and bounded retry; with it
disabled, the error suggests `/compact`. It never silently drops messages.
A very large single prompt or a summary that itself cannot fit may still need
a smaller input or output limit.

Set `"contextGuard": false` on the provider in `~/.pired/models.json` to
opt out, then reload/restart pi. The guard works in both `pired` and plain
`pi` **when a pired extension is loaded**. The JSON mirror cannot carry a
runtime guard: extension-less child processes retain pi's own budgeting.
Other API adapters are unchanged.

### SGLang behind Bifrost

Bifrost hides SGLang's overflow error from pi on both OpenAI APIs; see
[Bifrost #3131](https://github.com/maximhq/bifrost/issues/3131). Measured on
SGLang with a 262,144-token window:

| API | SGLang counts | What pi receives |
|---|---|---|
| `openai-completions` | input + `max_tokens` | HTTP 400 `provider API error (status 400)` |
| `openai-responses`, streamed | input | HTTP 200, then `response.failed` with an empty message |

Neither matches pi's overflow patterns, so pi neither compacts nor retries; the
turn ends with the error, every time the window fills. (A buffered
`/v1/responses` call does carry SGLang's text, but pi streams.) The local guard
keeps such requests from being sent; it does not label arbitrary gateway errors
as context overflow. Plain `pi` without a pired extension loaded has no guard
and fails this way on either API.

The gateway-side correction is to preserve SGLang's upstream message and map
genuine context overflows to `context_length_exceeded`. That lets pi recognize
the error and recover. It does not increase the model's context window.
For diagnosis, inspect the SGLang response directly or use Bifrost's
[Include Raw Response option](https://github.com/maximhq/bifrost/blob/main/docs/quickstart/gateway/provider-configuration.mdx).
Do not share raw requests or credentials when reporting the error.

## `compat`, and the failure it prevents

```jsonc
"compat": { "thinkingFormat": "qwen" }
```

This one is worth knowing about, because getting it wrong produces a failure that looks like success.

A Qwen model served by LM Studio returns its reasoning in `reasoning_content` and leaves `content` empty. Without `thinkingFormat: "qwen"`, the agent receives an empty message, prints nothing, and **exits 0** — a total failure indistinguishable from a clean no-op run.

Other switches (`supportsDeveloperRole`, `supportsReasoningEffort`, and anything else pi accepts) pass through at both provider and model level, with the model's winning.

## Costs

Models registered this way are declared at zero cost, since a local server has none in the sense pi means. If you register a metered provider (OpenRouter, say) this way, pi's cost accounting for it will read zero — the engagement still runs correctly, but do not use those numbers for billing.

## Thinking depth

Reasoning depth is pi's `--thinking` (`off` | `low` | `medium` | `high` | `max`). The `pired` launcher defaults to **`high`**: a security review is exactly the workload where the reasoning budget pays for itself, and pired's own benchmark was run there.

Hidden reasoning is labelled `thinking` in the transcript, and the thinking level is colour-coded by the theme.
