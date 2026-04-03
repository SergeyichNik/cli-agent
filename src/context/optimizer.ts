import type { Message } from '../providers/base.js';
import type { WorkingMemory } from '../memory/wm.js';
import type { LongTermMemory } from '../memory/ltm.js';
import type { UserConfig } from '../user/profile.js';

export function buildSystemPrompt(
  config: UserConfig,
  ltm: LongTermMemory,
  sessionId: string,
): string {
  const facts = ltm.getFactsBySession(sessionId);
  const factLines = facts.map((f) => `- ${f.key}: ${f.value}`).join('\n');

  const sessionInvariants = ltm.getSessionInvariants(sessionId);
  const allInvariants = [...(config.invariants ?? []), ...sessionInvariants];
  const invariantLines = allInvariants.map((inv) => `- ${inv}`).join('\n');

  return `You are a CLI code assistant agent helping ${config.userName ?? 'the user'}.

## User Preferences
- Preferred language: ${config.preferredLanguage ?? 'English'}
- Response style: ${config.responseStyle ?? 'concise'}

## Known Facts (this session)
${factLines || '(none yet)'}

## Rules You Must Follow
- Always respond in the user's preferred language (${config.preferredLanguage ?? 'English'})
- Before taking any destructive action, explain what you're about to do
- Stay within the working directory scope unless explicitly permitted
- Do not hallucinate file contents; use tools to read files
${invariantLines}

## Response Format
Start EVERY response with a JSON metadata line (on its own line), then your actual response:
{"intent":"NEW_TASK|CLARIFICATION|PAUSE|RESUME|CONFIRM|QUESTION|OTHER","state_transition":"CURRENT→NEXT or null"}

Example:
{"intent":"NEW_TASK","state_transition":"IDLE→PLANNING"}
Here is my plan to implement the feature...`;
}

export function buildContext(
  userMessage: string,
  systemPrompt: string,
  wm: WorkingMemory,
  ltm: LongTermMemory,
): Message[] {
  const relevantSummaries = ltm.searchRelevant(userMessage);
  const summaryNote =
    relevantSummaries.length > 0
      ? `\n\n## Relevant Past Sessions\n${relevantSummaries.map((s) => `- ${s.summary}`).join('\n')}`
      : '';

  const messages: Message[] = [
    { role: 'system', content: systemPrompt + summaryNote },
    ...wm.getWindow(),
    { role: 'user', content: userMessage },
  ];

  return messages;
}
