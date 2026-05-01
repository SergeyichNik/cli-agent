# Providers

The agent supports multiple LLM providers. The active provider is set in `.agent/config.json`
via the `provider` field (`"deepseek"` or `"lmstudio"`) and can be overridden at runtime with the
`--provider` CLI flag.

---

## Architecture

All providers implement the common interface `LLMProvider` from `src/providers/base.ts`:

```typescript
export interface LLMProvider {
  stream(messages: Message[], options?: LLMOptions): AsyncIterable<Chunk>;
}
```

### Chunk types

The stream yields typed chunks that the agent loop processes in real-time:

| Chunk type     | Fields                          | Description                            |
|----------------|----------------------------------|----------------------------------------|
| `text`         | `text: string`                   | A fragment of generated content        |
| `tool_call`    | `id`, `name`, `arguments`        | A complete tool call request           |
| `done`         | `finish_reason: string`          | Signals end of stream (`"stop"`)       |
| `usage`        | `input_tokens`, `output_tokens`  | Token usage (final chunk)              |
| `reasoning`    | `text: string`                   | Reasoning / chain-of-thought (DeepSeek)|

### Message format

Messages use the OpenAI Chat Completions format via `ChatCompletionMessageParam`:

```typescript
export type Message = ChatCompletionMessageParam;
```

### Options

```typescript
export interface LLMOptions {
  tools?: ChatCompletionTool[];    // Tool definitions for function calling
  temperature?: number;            // Sampling temperature (default: 0.7)
  maxTokens?: number;              // Max output tokens
}
```

---

## Available Providers

### DeepSeek (remote)

**File:** `src/providers/deepseek.ts`
**Class:** `DeepSeekProvider`

Primary remote provider. Uses the OpenAI-compatible DeepSeek API.

```typescript
constructor(
  apiKey: string,
  model = 'deepseek-v4-flash',
  baseURL = 'https://api.deepseek.com',
)
```

**Features:**
- Full streaming support with tool calls
- Reasoning content (`reasoning_content` in delta) — native DeepSeek chain-of-thought
- Retry logic (`streamWithRetry`, up to 3 attempts with exponential backoff)
- Usage tracking (prompt & completion tokens)

**Configuration:**

```json
// ~/.config/agent/secrets.json
{
  "deepseek": {
    "apiKey": "sk-...",
    "baseUrl": "https://api.deepseek.com"   // optional
  }
}
```

Or via environment variable: `DEEPSEEK_API_KEY`, `DEEPSEEK_BASE_URL`.

---

### LM Studio (local)

**File:** `src/providers/lmstudio.ts`
**Class:** `LMStudioProvider`

Local provider for running models via [LM Studio](https://lmstudio.ai/) or any OpenAI-compatible
local inference server.

```typescript
constructor(
  model = 'local-model',
  baseURL = 'http://localhost:1234/v1',
)
```

**Features:**
- No API key required (uses `"lm-studio"` as placeholder)
- Reuses `streamWithRetry` from DeepSeek provider (OpenAI-compatible streaming)
- Tool calls are **disabled** for LM Studio in the agent loop
  (`tools: []` is passed instead of actual tool definitions)

**Configuration:**

```json
// ~/.config/agent/secrets.json
{
  "lmstudio": {
    "baseUrl": "http://localhost:1234/v1"
  }
}
```

Or via environment variable: `LMSTUDIO_BASE_URL`.

---

## How the provider is selected

In `src/cli/index.ts`:

1. Load project config from `.agent/config.json`
2. Check CLI `--provider` / `--model` flags (override project config)
3. Load API key from secrets file or environment variable
4. Create the provider:

```typescript
const provider =
  projectConfig.provider === 'deepseek'
    ? new DeepSeekProvider(apiKey, projectConfig.model, deepSeekUrl)
    : new LMStudioProvider(projectConfig.model, lmStudioUrl);
```

---

## Provider consumption

The provider is used in the agentic loop (`src/core/agent.ts`):

1. `provider.stream(messages, options)` yields typed chunks
2. Text chunks are rendered live via `StreamRenderer`
3. Tool call chunks are accumulated, validated, and executed
4. Usage chunks update token counters
5. Reasoning chunks are captured but not rendered to the user (internal)

Additional subsystems that consume the provider:

| File                     | Usage                                    |
|--------------------------|------------------------------------------|
| `src/context/sticky.ts`  | Extracts session facts from conversation |
| `src/context/summarizer.ts` | Summarizes context when WM is full    |

---

## Future providers

From `ROADMAP.md` — **ClaudeProvider** (`src/providers/claude.ts`) is the next planned provider,
which would add access to Anthropic Claude models and enable image (vision) support.

---

## Adding a new provider

1. Create `src/providers/<name>.ts`
2. Implement `LLMProvider` interface (export a class with `stream()` method)
3. Import and instantiate in `src/cli/index.ts` with the appropriate config logic
4. Add the provider name to `ProjectConfigSchema` in `src/agent/config.ts`
5. Add secret key handling in `src/agent/secrets.ts`
