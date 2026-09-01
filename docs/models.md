# Models

Model selection is **pi's** — `/model`, or `Ctrl+P` to cycle. pired does not replace the picker; it adds to it.

What pired contributes is `~/.pired/models.json`: any OpenAI-compatible provider — LM Studio, Ollama, llama.cpp, OpenRouter, vLLM, a corporate proxy — registered into pi's own picker alongside your built-in and subscription models.

## Adding a provider

`/login` is where you tell a tool about a model it does not yet have, so that is where this lives: pired puts **"Add a custom provider…"** in pi's own login list, under *Sign in with an account*. `/login add-provider` goes straight there, and **`/provider`** opens the same wizard by name.

It asks, in order:

| | |
|---|---|
| **Which server** | LM Studio, Ollama, llama.cpp, vLLM, OpenRouter — each prefilled with the port it ships on — or another OpenAI-compatible address. |
| **Base URL** | `localhost:1234/v1` is enough; the scheme is filled in (`http` for a host on this box, `https` otherwise). |
| **API** | Only for a host with no preset: `openai-completions` for nearly everything, or an Anthropic-, Responses- or Gemini-shaped endpoint. |
| **Token** | Or **`$ENV_VAR`**, which is stored as the reference and read from the environment at request time — the answer when the key is a client's. |
| **Model** | pired asks the host what it serves (`GET {baseUrl}/models`) and offers the list; several hundred models becomes a search instead. If the host does not answer, you type the id — and the failure is reported, because it is the same failure the agent would have hit later. |
| **Size** | Context window and output cap, taken from the host's own answer where it gives one. |
| **Thinking** | Whether the model reasons, and in which wire format — see [`compat`](#compat-and-the-failure-it-prevents) below. The likely one is offered first. |

Then it shows what it will write, and writes it: `~/.pired/models.json`, readable only by you, plus pi's own `~/.pi/agent/models.json` so that subagents — which run without pired's extension — can resolve the model too. The provider is registered immediately, so it is in `/model` without a restart, and the wizard offers to switch to it.

```
/provider             add one (the same wizard /login opens)
/provider list        what is configured, and what each provider serves
/provider remove <id> forget one — pired's file, pi's mirror, and this session
```

Nothing here is required: the file is plain JSON and can still be written by hand.

## Why local models are the default case

A consultant under NDA often *cannot* paste client source into a frontier API. That is a contract term, not a preference.

So pired is tuned for ~30B open-weight models running on the engagement box, and the benchmark is built around that constraint: pired + Qwen3.8 27B locally reached **0.74 recall** against 0.68 for a frontier agent on the same target, with 100% critical recall — the lift coming from the security-tuned prompt rather than from model size. See [Evaluation](evaluation.md).

Frontier and subscription models work fine too, wherever the engagement allows them. Nothing in pired assumes a local model.

## `~/.pired/models.json`

What the wizard writes, and what you can write yourself:

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
