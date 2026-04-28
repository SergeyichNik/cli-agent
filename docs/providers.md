# Providers

The agent supports two LLM providers. Set the active provider in `.agent/config.json` or via `--provider` flag.

## DeepSeek

Remote API. Requires an API key.

**Setup:**

```json
// ~/.config/agent/secrets.json
{
  "deepseek": {
    "apiKey": "sk-...",
    "baseUrl": "https://api.deepseek.com"  // optional, this is the default
  }
}
```

**Config:**

```json
// .agent/config.json
{
  "provider": "deepseek",
  "model": "deepseek-chat"
}
```

**Start:**

```bash
agent --provider deepseek
# or set "provider": "deepseek" in .agent/config.json and just run:
agent
```

**Implementation:** `src/providers/deepseek.ts` — wraps OpenAI SDK with DeepSeek base URL, includes retry logic with exponential backoff (max 3 retries).

## LM Studio

Local model server. No API key needed.

**Setup:**

1. Install [LM Studio](https://lmstudio.ai)
2. Download a model
3. Start the local server (default: `http://localhost:1234/v1`)

**Config:**

```json
// .agent/config.json
{
  "provider": "lmstudio",
  "model": "your-model-name"
}
```

**Start:**

```bash
agent --provider lmstudio
```

**Implementation:** `src/providers/lmstudio.ts` — OpenAI-compatible client pointing to `http://localhost:1234/v1`.

## Switching Providers

You can switch providers per-session without changing config:

```bash
agent --provider deepseek --model deepseek-chat
agent --provider lmstudio --model llama-3.2-3b
```
