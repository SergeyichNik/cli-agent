import { get_encoding } from 'tiktoken';
import type { Message } from '../providers/base.js';

const enc = get_encoding('cl100k_base');

function countTokens(text: string): number {
  return enc.encode(text).length;
}

function messageTokens(msg: Message): number {
  let text = '';
  if (typeof msg.content === 'string') text = msg.content;
  else if (Array.isArray(msg.content)) {
    for (const part of msg.content) {
      if ('text' in part) text += part.text;
    }
  }
  return countTokens(text) + 4; // 4 tokens overhead per message
}

export class WorkingMemory {
  private messages: Message[] = [];
  private readonly limit: number;

  constructor(tokenLimit = 4000) {
    this.limit = tokenLimit;
  }

  add(msg: Message): void {
    this.messages.push(msg);
  }

  getWindow(): Message[] {
    return [...this.messages];
  }

  tokenCount(): number {
    return this.messages.reduce((sum, m) => sum + messageTokens(m), 0);
  }

  isFull(): boolean {
    return this.tokenCount() > this.limit * 0.8;
  }

  /** Returns and removes the oldest half of messages for summarization */
  popOldestHalf(): Message[] {
    const half = Math.floor(this.messages.length / 2);
    const oldest = this.messages.splice(0, half);
    return oldest;
  }

  /** Prepend a summary message (injected after summarization) */
  prependSummary(summary: string): void {
    this.messages.unshift({
      role: 'system',
      content: `[Conversation summary: ${summary}]`,
    });
  }
}
