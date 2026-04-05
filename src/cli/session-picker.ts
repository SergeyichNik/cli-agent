import * as p from '@clack/prompts';
import type { SessionRow } from '../memory/ltm.js';
import type { LongTermMemory } from '../memory/ltm.js';
import type { Task } from '../core/task-state.js';

type PickResult =
  | { type: 'new' }
  | { type: 'resume'; sessionId: string; task: Task | null };

function formatDate(ts: number): string {
  return new Date(ts).toISOString().slice(0, 10);
}

function ctxColor(pct: number, text: string): string {
  if (pct >= 90) return `\x1b[31m${text}\x1b[0m`;
  if (pct >= 70) return `\x1b[33m${text}\x1b[0m`;
  return text;
}

function sessionLabel(s: SessionRow): string {
  const date = formatDate(s.started_at);
  const title = s.task ?? 'Untitled session';
  const status = s.ended_at != null
    ? '\x1b[2m(done)\x1b[0m'
    : ctxColor(s.ctx_pct, `(${s.ctx_pct}% ctx)`);
  return `[${date}] ${title}  ${status}`;
}

function showTaskRecap(task: Task): void {
  const stateColor =
    task.state === 'execution' ? '\x1b[33m' :
    task.state === 'validation' ? '\x1b[36m' :
    task.state === 'planning' ? '\x1b[34m' :
    task.state === 'paused' ? '\x1b[2m' : '\x1b[0m';

  process.stdout.write('\n');
  process.stdout.write(`\x1b[1m◈ Unfinished task detected\x1b[0m\n`);
  process.stdout.write(`  Task:   ${task.task}\n`);
  process.stdout.write(`  State:  ${stateColor}${task.state}\x1b[0m`);
  if (task.total > 0) {
    process.stdout.write(`  |  Step ${task.step}/${task.total}`);
  }
  process.stdout.write('\n');
  if (task.current) {
    process.stdout.write(`  Last:   ${task.current}\n`);
  }
  process.stdout.write('\n');
}

export async function pickSession(
  userName: string,
  ltm: LongTermMemory,
): Promise<PickResult> {
  let sessions = ltm.getSessionList(userName);

  // eslint-disable-next-line no-constant-condition
  while (true) {
    const options: Array<{ value: string; label: string; hint?: string }> = [
      { value: '__new__', label: '+ New session' },
      ...sessions.map((s) => ({
        value: s.id,
        label: sessionLabel(s),
      })),
    ];

    const choice = await p.select({
      message: `Welcome back, \x1b[1m${userName}\x1b[0m — pick a session`,
      options,
    });

    if (p.isCancel(choice)) {
      p.cancel('Cancelled.');
      process.exit(0);
    }

    if (choice === '__new__') {
      return { type: 'new' };
    }

    // Existing session selected — offer resume or delete
    const action = await p.select({
      message: 'What would you like to do?',
      options: [
        { value: 'resume', label: 'Resume this session' },
        { value: 'delete', label: '\x1b[31mDelete this session\x1b[0m' },
        { value: 'back', label: '← Back' },
      ],
    });

    if (p.isCancel(action) || action === 'back') {
      continue;
    }

    if (action === 'resume') {
      const sessionId = choice as string;
      const task = ltm.getTaskState(sessionId);

      // Show recap if there's an unfinished task
      if (task && task.state !== 'done' && task.state !== 'error') {
        showTaskRecap(task);
        const continueTask = await p.confirm({
          message: 'Continue this task?',
          initialValue: true,
        });
        if (p.isCancel(continueTask) || !continueTask) {
          return { type: 'resume', sessionId, task: null };
        }
      }

      return { type: 'resume', sessionId, task: task ?? null };
    }

    if (action === 'delete') {
      const confirmed = await p.confirm({
        message: 'Delete this session and all its facts/summaries? This cannot be undone.',
        initialValue: false,
      });
      if (!p.isCancel(confirmed) && confirmed) {
        ltm.deleteSession(choice as string);
        sessions = ltm.getSessionList(userName);
        p.log.success('Session deleted.');
      }
      // loop back to picker
    }
  }
}
