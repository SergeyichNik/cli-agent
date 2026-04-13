export interface EmbeddingProvider {
  embed(texts: string[]): Promise<number[][]>;
}

export interface EmbeddingConfig {
  type: 'ollama' | 'openai-compatible';
  model?: string;
  url?: string;
  apiKey?: string;
}

export class OllamaProvider implements EmbeddingProvider {
  constructor(
    private model = 'nomic-embed-text',
    private url = 'http://localhost:11434',
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.url}/api/embed`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      // truncate: true — Ollama silently truncates inputs that exceed the model context
      // num_ctx: 8192 — use the full context window if the Ollama version supports it
      body: JSON.stringify({ model: this.model, input: texts, truncate: true, options: { num_ctx: 8192 } }),
    });
    if (!response.ok) {
      throw new Error(`Ollama embed failed (${response.status}): ${await response.text()}`);
    }
    const data = await response.json() as { embeddings: number[][] };
    return data.embeddings;
  }
}

export class OpenAICompatibleProvider implements EmbeddingProvider {
  constructor(
    private model: string,
    private url: string,
    private apiKey: string,
  ) {}

  async embed(texts: string[]): Promise<number[][]> {
    const response = await fetch(`${this.url}/v1/embeddings`, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${this.apiKey}`,
      },
      body: JSON.stringify({ model: this.model, input: texts }),
    });
    if (!response.ok) {
      throw new Error(`OpenAI-compatible embed failed (${response.status}): ${await response.text()}`);
    }
    const data = await response.json() as { data: { embedding: number[] }[] };
    return data.data.map(d => d.embedding);
  }
}

export function createProvider(config: EmbeddingConfig): EmbeddingProvider {
  if (config.type === 'openai-compatible') {
    return new OpenAICompatibleProvider(
      config.model ?? 'text-embedding-ada-002',
      config.url ?? 'http://localhost:1234',
      config.apiKey ?? '',
    );
  }
  // Default: Ollama
  return new OllamaProvider(
    config.model ?? 'nomic-embed-text',
    config.url ?? 'http://localhost:11434',
  );
}
