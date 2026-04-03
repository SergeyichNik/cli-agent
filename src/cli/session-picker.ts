import * as p from '@clack/prompts';
import type { SessionRow } from '../memory/ltm.js';
import type { LongTermMemory } from '../memory/ltm.js';

type PickResult = { type: 'new' } | { type: 'resume'; sessionId: string };

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
      return { type: 'resume', sessionId: choice as string };
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
