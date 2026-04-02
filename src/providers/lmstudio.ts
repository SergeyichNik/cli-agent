import OpenAI from 'openai';
import type { LLMProvider, LLMOptions, Chunk, Message } from './base.js';
import { streamWithRetry } from './deepseek.js';

export class LMStudioProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(model = 'local-model', baseURL = 'http://localhost:1234/v1') {
    this.client = new OpenAI({
      baseURL,
      apiKey: 'lm-studio',
    });
    this.model = model;
  }

  async *stream(messages: Message[], options: LLMOptions = {}): AsyncIterable<Chunk> {
    yield* streamWithRetry(this.client, this.model, messages, options);
  }
}
