import type { Message } from '../providers/base.js';
import type { WorkingMemory } from '../memory/wm.js';
import type { LongTermMemory } from '../memory/ltm.js';
import type { UserConfig } from '../user/profile.js';
import type { TaskState, Task } from '../core/task-state.js';

function buildStateBlock(state: TaskState, task: Task | null): string {
  switch (state) {
    case 'planning':
      return `
## Current State: PLANNING
First, classify the task as SIMPLE or COMPLEX.

**SIMPLE task** — any of the following:
- Conversational message, greeting, or question answerable without tools
- Single-file change or small code snippet
- Explanation, translation, or summarization
- Any task completable in one action without ambiguity

→ For SIMPLE tasks: immediately emit CONFIRM with a concise 1–2 step plan. Do NOT ask any questions.
{"intent":"CONFIRM","plan":["Step 1: <what you will do>"]}

**COMPLEX task** — requires all of:
- Multiple interdependent files or components
- Genuine architectural ambiguity that needs user input
- More than ~3 distinct implementation steps

→ For COMPLEX tasks: gather information through questions, then produce a plan.

STRICT RULES for COMPLEX tasks only:
- DO NOT use any tools (no file reads, no shell commands, no writes)
- Ask ONE question at a time — never ask multiple questions in a single response
- Each question MUST include 3–4 concrete answer options and a recommendation
- After the user answers, ask the NEXT question if needed
- Only when you have enough information: emit CONFIRM with the full plan array

Question format (COMPLEX tasks only):
{"intent":"QUESTION","options":["Option A","Option B","Option C","Option D"],"recommended":0}
Then write your question text and briefly explain why you recommend that option.

When plan is ready (both SIMPLE and COMPLEX):
{"intent":"CONFIRM","plan":["Step 1: ...","Step 2: ...","Step 3: ..."]}

`;

    case 'execution': {
      let progressBlock = '';
      if (task && task.total > 0) {
        const doneLines = task.done.map((s, i) => `  ✓ ${i + 1}. ${s}`).join('\n');
        const remaining = task.plan.slice(task.step);
        const remainingLines = remaining.map((s, i) => `  ○ ${task.step + i + 1}. ${s}`).join('\n');
        progressBlock = `
## Task Progress
Current step: ${task.step + 1} / ${task.total} — "${task.current}"
${task.done.length > 0 ? `Completed:\n${doneLines}` : 'Completed: (none yet)'}
Remaining (including current):
${remainingLines}
`;
      }
      return `
## Current State: EXECUTION
${progressBlock}
STRICT RULES:
- Execute ONLY the current step listed above. Do not jump ahead.
- When the current step is FULLY implemented, emit: {"intent":"OTHER","step_done":true}
- Do NOT emit step_done:true until the step is completely done and verified
- After step_done, immediately proceed to the next step without waiting for user input
- When ALL steps are done (step === total), emit: {"intent":"CONFIRM"} to move to validation

`;}

    case 'validation':
      return `
## Current State: VALIDATION
Review what was implemented. Verify correctness and completeness against the plan.
If issues found, emit intent OTHER to go back to execution.
If everything looks good, emit intent CONFIRM to mark the task as done.

`;
    case 'paused':
      return `
## Current State: PAUSED
The task is paused. Wait for the user to resume before taking any action.

`;
    default:
      return '';
  }
}

export function buildSystemPrompt(
  config: UserConfig,
  ltm: LongTermMemory,
  sessionId: string,
  taskState: TaskState = 'planning',
  task: Task | null = null,
  sandboxDir = '',
): string {
  const facts = ltm.getFactsBySession(sessionId);
  const factLines = facts.map((f) => `- ${f.key}: ${f.value}`).join('\n');

  const sessionInvariants = ltm.getSessionInvariants(sessionId);
  const allInvariants = [...(config.invariants ?? []), ...sessionInvariants];
  const invariantLines = allInvariants.map((inv) => `- ${inv}`).join('\n');

  const stateBlock = buildStateBlock(taskState, task);

  const mcpServers = config.mcpServers ?? {};
  // Built-in servers handled separately — exclude from external integrations block
  const BUILTIN_SERVERS = new Set(['files', 'git', 'search']);
  const externalMcpNames = Object.keys(mcpServers).filter((s) => !BUILTIN_SERVERS.has(s));
  const mcpBlock = externalMcpNames.length > 0
    ? `\n## Available External Integrations (MCP)\nYou have access to real external services via MCP tools.\n\n### CRITICAL: When to use MCP tools vs local tools\n\n**Scenario A — user asks to CREATE/LIST/UPDATE things IN an external service:**\n> "create Linear tasks for MVP", "add issues to GitHub", "show my Linear backlog"\n→ The ENTIRE plan must be MCP tool calls only. Do NOT create local files. Do NOT build anything locally. Every execution step = a call to the external service's MCP tool.\n\n**Scenario B — user asks to BUILD something and track it:**\n> "build a todo app and create Linear tasks to track it"\n→ Plan can mix local steps AND MCP steps.\n\nIf the user's request mentions an external service name (${externalMcpNames.join(', ')}) as the destination, treat it as Scenario A.\n\nAvailable services:\n${externalMcpNames.map((name) => `- **${name}**: \`${name}__list_teams\` (get team UUID first!), \`${name}__create_issue\`, \`${name}__list_issues\`, \`${name}__update_issue\`. Always call \`${name}__list_teams\` before \`${name}__create_issue\` to get the required UUID.`).join('\n')}\n`
    : '';

  const hasSearch = 'search' in mcpServers;
  const searchBlock = hasSearch
    ? `\n## Search Index (semantic search over project files)\nYou have a local vector search index. Use it to find relevant code/docs before reading files manually.\n\n**Workflow:**\n1. At the START of a session (or when asked about code you haven't seen), call \`search__index_status\` to check if the index is populated.\n2. If the index is empty and the user asks about code, suggest running \`search__index_documents\` first.\n3. Before reading a file to answer a question, try \`search__search\` first — it's faster.\n\n**Tools:**\n- \`search__index_documents(glob, strategy)\` — index files. Use \`strategy: "both"\` to compare chunking strategies.\n- \`search__search(query, topK?, strategy?, source?)\` — semantic search, returns top-K chunks with scores.\n- \`search__index_status()\` — show index stats (chunk counts, last indexed time).\n- \`search__reindex(glob?)\` — delete and re-index files after changes.\n\n**Indexing — always use broad globs, never per-file:**\n- CORRECT: one call with \`glob: "**/*.ts"\` indexes all TypeScript files in one batch\n- WRONG: calling \`index_documents\` once per file — extremely slow, never do this\n- For mixed projects, use 2 calls max: one for code (\`**/*.ts\`), one for docs (\`**/*.md\`)\n- Auto-excluded (no need to filter manually): node_modules, dist, build, .git, .agent, .cache, coverage, vendor, *.d.ts\n\n**When to use:**\n- User asks "where is X implemented?" → search before reading files\n- User asks "how does Y work?" → search for relevant chunks\n- User asks to index/search docs explicitly → do it directly\n`
    : '';

  const cwdBlock = sandboxDir
    ? `\n## Working Directory\nYour current working directory for ALL file and shell operations is: ${sandboxDir}\nAll paths must be relative to this directory. Do not assume project-root paths exist here.\n`
    : '';

  return `You are a CLI code assistant agent helping ${config.userName ?? 'the user'}.
${mcpBlock}${searchBlock}
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

${cwdBlock}
## State Machine
The task follows a strict state machine: planning → execution → validation → done.
For SIMPLE tasks: immediately emit CONFIRM in planning to proceed to execution with a short plan.
For COMPLEX tasks: do NOT skip states without completing their requirements.
If the user asks to skip a state that has unmet conditions (e.g. "mark done" before steps are complete):
  1. REFUSE the request clearly
  2. Explain which condition must be met
  3. Continue in the current state
  4. Do NOT emit an intent that would trigger the forbidden transition

${stateBlock}
## Response Format
Start EVERY response with a JSON metadata line (on its own line, before any text).

**When plan is ready** (planning state, all steps defined):
{"intent":"CONFIRM","plan":["Step 1: description","Step 2: description","Step 3: description"]}

**When current execution step is fully complete**:
{"intent":"OTHER","step_done":true}

**When asking the user a question with discrete options**:
{"intent":"QUESTION","options":["Option A","Option B","Option C"],"recommended":0}

**All other responses**:
{"intent":"NEW_TASK|CLARIFICATION|CONFIRM|QUESTION|OTHER"}

Intent values:
- NEW_TASK: starting a new task from scratch
- CLARIFICATION: asking for or providing clarification
- CONFIRM: plan is ready (→execution), all steps done (→validation), or validation passed (→done)
- QUESTION: asking the user a question mid-task
- OTHER: normal response within current state, or step completed

Rules:
- Include "plan" array ONLY when you have a complete, finalized plan (do not include during planning iterations)
- Include "step_done":true ONLY when the current step is FULLY implemented/complete
- Include "options" array when you present the user with 3–4 discrete choices to pick from
- Include "recommended" (0-based index into options) to indicate your preferred option
- Never include both "plan" and "step_done" in the same response
- Plan steps must be specific, actionable, and atomic`;
}

export function buildContext(
  userMessage: string,
  systemPrompt: string,
  wm: WorkingMemory,
  ltm: LongTermMemory,
  task: Task | null = null,
  taskState: TaskState = 'planning',
): Message[] {
  const relevantSummaries = ltm.searchRelevant(userMessage);
  const summaryNote =
    relevantSummaries.length > 0
      ? `\n\n## Relevant Past Sessions\n${relevantSummaries.map((s) => `- ${s.summary}`).join('\n')}`
      : '';

  const messages: Message[] = [
    { role: 'system', content: systemPrompt + summaryNote },
    ...wm.getWindow(),
  ];

  // Inject step reminder as the last message before user input so LLM can't ignore it
  if (taskState === 'execution' && task && task.current) {
    const done = task.done.map((s, i) => `  ✓ ${i + 1}. ${s}`).join('\n');
    const remaining = task.plan.slice(task.step + 1).map((s, i) => `  ○ ${task.step + i + 2}. ${s}`).join('\n');
    messages.push({
      role: 'user',
      content: [
        `[STEP INSTRUCTION] You are on step ${task.step + 1} of ${task.total}.`,
        `Your ONLY job right now: "${task.current}"`,
        `Do ONLY this step. Do NOT implement anything beyond it.`,
        done ? `Already done:\n${done}` : null,
        remaining ? `Still ahead (do NOT touch yet):\n${remaining}` : null,
        `When this step is fully complete, emit: {"intent":"OTHER","step_done":true}`,
      ].filter(Boolean).join('\n'),
    });
    messages.push({ role: 'assistant', content: 'Understood. I will execute only this step.' });
  }

  messages.push({ role: 'user', content: userMessage });

  return messages;
}
