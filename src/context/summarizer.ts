import type { LLMProvider, Message } from '../providers/base.js';
import type { WorkingMemory } from '../memory/wm.js';
import type { LongTermMemory } from '../memory/ltm.js';

export async function summarizeIfNeeded(
  provider: LLMProvider,
  wm: WorkingMemory,
  ltm: LongTermMemory,
  sessionId: string,
  localMode = false,
): Promise<void> {
  if (!wm.isFull()) return;

  const oldest = wm.popOldestHalf();
  if (oldest.length === 0) return;

  // Local models: skip LLM summarization to avoid adding another call under memory pressure
  if (localMode) return;

  const messages: Message[] = [
    {
      role: 'system',
      content: 'Summarize the following conversation excerpt in 3-5 sentences. Focus on decisions made, tasks completed, and key information exchanged. Be concise.',
    },
    ...oldest,
    { role: 'user', content: 'Provide a brief summary of the above conversation.' },
  ];

  let summary = '';
  for await (const chunk of provider.stream(messages, { temperature: 0.3 })) {
    if (chunk.type === 'text') summary += chunk.text;
  }

  summary = summary.trim();
  if (summary) {
    ltm.saveSessionSummary(sessionId, summary);
    wm.prependSummary(summary);
  }
}
