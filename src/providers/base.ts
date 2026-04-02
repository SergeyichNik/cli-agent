import type { ChatCompletionMessageParam, ChatCompletionTool } from 'openai/resources/chat/completions.js';

export type Message = ChatCompletionMessageParam;

export interface TextChunk {
  type: 'text';
  text: string;
}

export interface ToolCallChunk {
  type: 'tool_call';
  id: string;
  name: string;
  arguments: string;
}

export interface DoneChunk {
  type: 'done';
  finish_reason: string;
}

export interface UsageChunk {
  type: 'usage';
  input_tokens: number;
  output_tokens: number;
}

export type Chunk = TextChunk | ToolCallChunk | DoneChunk | UsageChunk;

export interface LLMOptions {
  tools?: ChatCompletionTool[];
  temperature?: number;
  maxTokens?: number;
}

export interface LLMProvider {
  stream(messages: Message[], options?: LLMOptions): AsyncIterable<Chunk>;
}
