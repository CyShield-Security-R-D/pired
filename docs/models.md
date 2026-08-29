# Models

Model selection is **pi's** — `/model`, or `Ctrl+P` to cycle. pired does not replace the picker; it adds to it.

What pired contributes is `~/.pired/models.json`: any OpenAI-compatible provider — LM Studio, Ollama, llama.cpp, OpenRouter, vLLM, a corporate proxy — registered into pi's own picker alongside your built-in and subscription models.

## Why local models are the default case

A consultant under NDA often *cannot* paste client source into a frontier API. That is a contract term, not a preference.

So pired is tuned for ~30B open-weight models running on the engagement box, and the benchmark is built around that constraint: pired + Qwen3.8 27B locally reached 0.81 recall against 0.68 for a frontier agent on the same target, because the lift came from the harness — coverage discipline — rather than the model. See [Evaluation](evaluation.md).

Frontier and subscription models work fine too, wherever the engagement allows them. Nothing in pired assumes a local model.

## `~/.pired/models.json`

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
| `apiKey` | `"local"` | Sent as the bearer token. |
| `api` | `openai-completions` | pi's API adapter. |
| `compat` | — | Compatibility switches; see below. |
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
