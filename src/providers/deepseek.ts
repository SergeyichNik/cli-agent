import OpenAI from 'openai';
import type { LLMProvider, LLMOptions, Chunk, Message } from './base.js';

export class DeepSeekProvider implements LLMProvider {
  private client: OpenAI;
  private model: string;

  constructor(apiKey: string, model = 'deepseek-chat', baseURL = 'https://api.deepseek.com') {
    this.client = new OpenAI({ baseURL, apiKey });
    this.model = model;
  }

  async *stream(messages: Message[], options: LLMOptions = {}): AsyncIterable<Chunk> {
    yield* streamWithRetry(this.client, this.model, messages, options);
  }
}

export async function* streamWithRetry(
  client: OpenAI,
  model: string,
  messages: Message[],
  options: LLMOptions,
  maxRetries = 3,
): AsyncIterable<Chunk> {
  let attempt = 0;
  while (true) {
    try {
      const stream = await client.chat.completions.create({
        model,
        messages: messages as OpenAI.Chat.ChatCompletionMessageParam[],
        stream: true,
        stream_options: { include_usage: true },
        tools: options.tools,
        temperature: options.temperature ?? 0.7,
        max_tokens: options.maxTokens,
      });

      // Accumulate tool call deltas
      const toolCallAccum: Record<number, { id: string; name: string; arguments: string }> = {};

      for await (const chunk of stream) {
        // Usage arrives in the final chunk (choices may be empty)
        if (chunk.usage) {
          yield {
            type: 'usage',
            input_tokens: chunk.usage.prompt_tokens,
            output_tokens: chunk.usage.completion_tokens,
          };
        }

        const choice = chunk.choices[0];
        if (!choice) continue;

        const delta = choice.delta;

        if (delta.content) {
          yield { type: 'text', text: delta.content };
        }

        if (delta.tool_calls) {
          for (const tc of delta.tool_calls) {
            const idx = tc.index;
            if (!toolCallAccum[idx]) {
              toolCallAccum[idx] = { id: tc.id ?? '', name: tc.function?.name ?? '', arguments: '' };
            }
            if (tc.id) toolCallAccum[idx].id = tc.id;
            if (tc.function?.name) toolCallAccum[idx].name = tc.function.name;
            if (tc.function?.arguments) toolCallAccum[idx].arguments += tc.function.arguments;
          }
        }

        if (choice.finish_reason) {
          for (const tc of Object.values(toolCallAccum)) {
            yield { type: 'tool_call', id: tc.id, name: tc.name, arguments: tc.arguments };
          }
          yield { type: 'done', finish_reason: choice.finish_reason };
        }
      }
      return;
    } catch (err) {
      attempt++;
      if (attempt >= maxRetries) throw err;
      await new Promise((r) => setTimeout(r, 500 * 2 ** attempt));
    }
  }
}
