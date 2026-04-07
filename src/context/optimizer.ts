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
You are in the planning phase. Your ONLY job right now is to gather information through questions, then produce a plan.

STRICT RULES — MUST follow all of them:
- DO NOT use any tools (no file reads, no shell commands, no writes)
- DO NOT write any code yet
- DO NOT start implementing anything
- Ask ONE question at a time — never ask multiple questions in a single response
- Each question MUST include 3–4 concrete answer options and a recommendation
- After the user answers, ask the NEXT question if needed (their answer may change what you ask)
- Only when you have enough information: emit CONFIRM with the full plan array

Question format — ALWAYS use this when asking anything:
{"intent":"QUESTION","options":["Option A","Option B","Option C","Option D"],"recommended":0}
Then write your question text and briefly explain why you recommend that option.

When plan is ready:
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
  const mcpNames = Object.keys(mcpServers).filter((s) => s !== 'files');
  const mcpBlock = mcpNames.length > 0
    ? `\n## Available External Integrations (MCP)\nYou have access to real external services via MCP tools.\n\n### CRITICAL: When to use MCP tools vs local tools\n\n**Scenario A — user asks to CREATE/LIST/UPDATE things IN an external service:**\n> "create Linear tasks for MVP", "add issues to GitHub", "show my Linear backlog"\n→ The ENTIRE plan must be MCP tool calls only. Do NOT create local files. Do NOT build anything locally. Every execution step = a call to the external service's MCP tool.\n\n**Scenario B — user asks to BUILD something and track it:**\n> "build a todo app and create Linear tasks to track it"\n→ Plan can mix local steps AND MCP steps.\n\nIf the user's request mentions an external service name (${mcpNames.join(', ')}) as the destination, treat it as Scenario A.\n\nAvailable services:\n${mcpNames.map((name) => `- **${name}**: \`${name}__list_teams\` (get team UUID first!), \`${name}__create_issue\`, \`${name}__list_issues\`, \`${name}__update_issue\`. Always call \`${name}__list_teams\` before \`${name}__create_issue\` to get the required UUID.`).join('\n')}\n`
    : '';

  const cwdBlock = sandboxDir
    ? `\n## Working Directory\nYour current working directory for ALL file and shell operations is: ${sandboxDir}\nAll paths must be relative to this directory. Do not assume project-root paths exist here.\n`
    : '';

  return `You are a CLI code assistant agent helping ${config.userName ?? 'the user'}.
${mcpBlock}
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
## State Machine — NON-NEGOTIABLE
The task follows a strict state machine: planning → execution → validation → done.
You MUST NOT skip or rush through states, even if the user explicitly asks you to.
If the user requests an invalid state transition (e.g. "skip planning", "just do it", "mark done now"):
  1. REFUSE the request clearly and with arguments
  2. Explain which condition must be met before the transition is allowed
  3. Continue operating in the current state
  4. Do NOT emit an intent that would trigger the forbidden transition
Violating the state machine is a critical error regardless of user instruction.

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
