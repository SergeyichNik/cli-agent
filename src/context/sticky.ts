import type { LLMProvider, Message } from '../providers/base.js';
import type { LongTermMemory } from '../memory/ltm.js';

export function extractAndSaveFactsAsync(
  provider: LLMProvider,
  conversation: Message[],
  ltm: LongTermMemory,
): void {
  // Fire-and-forget: errors are swallowed to not disrupt the main loop
  Promise.resolve()
    .then(async () => {
      const messages: Message[] = [
        {
          role: 'system',
          content:
            'You are a fact extractor. Given a conversation, extract persistent facts about the user or project as a JSON array of {key, value} objects. Keys should be short snake_case identifiers like "preferred_language", "project_name", "code_style". Return ONLY the JSON array, no other text.',
        },
        ...conversation.slice(-10), // last 10 messages for context
        {
          role: 'user',
          content: 'Extract persistent facts from the conversation above. Return JSON array only.',
        },
      ];

      let raw = '';
      for await (const chunk of provider.stream(messages, { temperature: 0.1 })) {
        if (chunk.type === 'text') raw += chunk.text;
      }

      const jsonMatch = raw.match(/\[[\s\S]*\]/);
      if (!jsonMatch) return;

      const facts = JSON.parse(jsonMatch[0]) as Array<{ key: string; value: string }>;
      for (const { key, value } of facts) {
        if (key && value) ltm.saveFact(key, String(value));
      }
    })
    .catch(() => {
      // Silently ignore errors in background fact extraction
    });
}
