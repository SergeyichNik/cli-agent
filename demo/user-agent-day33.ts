#!/usr/bin/env tsx
/**
 * День 33 — User Agent (симуляция пользователя)
 *
 * Протокол через Linear comments:
 *   Создаёт тикет → ждёт comment role:support →
 *   отвечает comment role:user → после MAX_EXCHANGES → comment role:resolved
 *
 * Usage:
 *   npm run demo:day33:user
 *   npm run demo:day33:user -- --problem "Как добавить MCP-сервер?"
 */

import { loadSecrets } from '../src/agent/secrets.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import type { Message } from '../src/providers/base.js';
import {
  getViewer, getFirstTeam, createIssue, listComments, createComment,
  RESOLVED_MARKER, sleep,
} from './lib/linear.js';

// ── Config ─────────────────────────────────────────────────────────────────

const POLL_MS = 8_000;
const MAX_EXCHANGES = 2;
const IS_TTY = process.stdout.isTTY;

const DEFAULT_PROBLEM = {
  title: 'Как переключить агента на LM Studio (локальная модель)?',
  description: `Хочу использовать агента с локальной моделью через LM Studio вместо DeepSeek.
Установил LM Studio и скачал модель, но не понимаю как настроить агента для работы с ней.

Вопросы:
- Что нужно прописать в конфиге чтобы переключить провайдер?
- Нужен ли API-ключ для LM Studio?
- Работает ли всё так же как с DeepSeek или есть ограничения?`,
  priority: 3,
};

const USER_FOLLOWUP_PROMPT = `Ты — разработчик, который настраивает CLI-инструмент agent и хочет использовать LM Studio.
Ты получил ответ поддержки. Задай один конкретный уточняющий вопрос — например, про конкретный параметр конфига,
URL, модель или ограничения локального режима.
Стиль: неформальный, 2-3 предложения. Пиши по-русски. НЕ говори что всё заработало.`;

const USER_RESOLVE_PROMPT = `Ты — разработчик, который настраивал CLI-инструмент agent для работы с LM Studio.
Поддержка всё объяснила и теперь всё работает. Напиши короткое сообщение (1-2 предложения):
подтверди что смог подключиться и запустить агент с локальной моделью. Поблагодари. Пиши по-русски, неформально.`;

// ── Colors ─────────────────────────────────────────────────────────────────

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', magenta: '\x1b[35m', red: '\x1b[31m',
};

const P = `${c.magenta}${c.bold}[USER]${c.reset}`;
function log(msg: string) { console.log(`${P} ${msg}`); }
function ok(msg: string)  { console.log(`${P} ${c.green}✓${c.reset} ${msg}`); }
function err(msg: string) { console.log(`${P} ${c.red}✗${c.reset} ${msg}`); }
function dim(msg: string) { console.log(`${P} ${c.dim}${msg}${c.reset}`); }

function spinner(label: string): () => void {
  if (!IS_TTY) { dim(`⟳ ${label}`); return () => {}; }
  const frames = ['⠋','⠙','⠹','⠸','⠼','⠴','⠦','⠧','⠇','⠏'];
  let i = 0;
  const t = setInterval(() => process.stdout.write(`\r${P} ${frames[i++ % frames.length]} ${label}`), 80);
  return () => { clearInterval(t); process.stdout.write('\r\x1b[K'); };
}

// ── Setup ──────────────────────────────────────────────────────────────────

const secrets = loadSecrets();
const LINEAR_KEY = process.env.LINEAR_USER_API_KEY
  ?? secrets.linearUser?.apiKey
  ?? process.env.LINEAR_API_KEY
  ?? secrets.linear?.apiKey
  ?? '';
const DEEPSEEK_KEY = process.env.DEEPSEEK_API_KEY ?? secrets.deepseek?.apiKey ?? '';

if (!LINEAR_KEY) { err('LINEAR_API_KEY не найден'); process.exit(1); }
if (!DEEPSEEK_KEY) { err('DEEPSEEK_API_KEY не найден'); process.exit(1); }

const deepseek = new DeepSeekProvider(DEEPSEEK_KEY, 'deepseek-chat');

// ── Args ───────────────────────────────────────────────────────────────────

const argv = process.argv.slice(2);
const pidx = argv.indexOf('--problem');
const nidx = argv.indexOf('--name');
const customProblem = pidx !== -1 ? argv[pidx + 1] : null;
const userName = nidx !== -1 ? argv[nidx + 1] : 'Пользователь';
const problem = customProblem
  ? { title: customProblem, description: `Вопрос: ${customProblem}`, priority: 3 }
  : DEFAULT_PROBLEM;

// ── Reply generation ───────────────────────────────────────────────────────

async function generateReply(supportAnswer: string, resolving: boolean): Promise<string> {
  const stop = spinner(resolving ? 'Подтверждаю решение...' : 'Формулирую уточнение...');
  const prompt = resolving ? USER_RESOLVE_PROMPT : USER_FOLLOWUP_PROMPT;
  const messages: Message[] = [
    { role: 'system', content: prompt },
    { role: 'user', content: `Ответ поддержки:\n\n${supportAnswer}` },
  ];
  let reply = '';
  let first = true;
  for await (const chunk of deepseek.stream(messages, { temperature: 0.7 })) {
    if (chunk.type === 'text') {
      if (first) { stop(); if (IS_TTY) process.stdout.write('\n'); first = false; }
      if (IS_TTY) process.stdout.write(chunk.text);
      reply += chunk.text;
    }
  }
  if (first) stop();
  if (IS_TTY) console.log('\n');
  else dim(`Сообщение: ${reply.trim()}`);
  return reply.trim();
}

// ── Main ───────────────────────────────────────────────────────────────────

console.log('');
console.log(`${c.magenta}${c.bold}╔══════════════════════════════════════════╗${c.reset}`);
console.log(`${c.magenta}${c.bold}║  User Agent — День 33                    ║${c.reset}`);
console.log(`${c.magenta}${c.bold}╚══════════════════════════════════════════╝${c.reset}`);
console.log('');

ok('LINEAR_API_KEY ✓');
ok('DEEPSEEK_API_KEY ✓');

const viewer = await getViewer(LINEAR_KEY);
log(`Аккаунт пользователя: ${viewer.name}`);

const team = await getFirstTeam(LINEAR_KEY);
log(`Команда: ${team.name}`);

const ticket = await createIssue(LINEAR_KEY, {
  title: `[${userName}] ${problem.title}`,
  teamId: team.id,
  description: `**От:** ${userName}\n\n${problem.description}`,
  priority: problem.priority,
});

ok(`Тикет создан: [${ticket.id}] ${ticket.title}`);
log(`URL: ${ticket.url}`);
log(`Жду ответа поддержки...\n`);

let lastSeenId: string | null = null;
let exchanges = 0;

while (true) {
  await sleep(POLL_MS);

  let comments;
  try {
    comments = await listComments(LINEAR_KEY, ticket.id);
  } catch (e: any) {
    err(`Ошибка чтения комментариев: ${e.message}`);
    continue;
  }

  const last = comments.at(-1);
  if (!last || last.id === lastSeenId) {
    dim('Ждём ответа поддержки...');
    continue;
  }

  // Skip own comments
  const isOwnComment = last.user?.id === viewer.id;
  if (isOwnComment) {
    lastSeenId = last.id;
    continue;
  }

  // New support comment received
  lastSeenId = last.id;
  exchanges++;
  log(`📨 Получен ответ поддержки (#${exchanges})`);

  const resolving = exchanges >= MAX_EXCHANGES;
  const reply = await generateReply(last.body.trim(), resolving);
  const body = resolving ? `${reply}\n\n${RESOLVED_MARKER}` : reply;
  await createComment(LINEAR_KEY, ticket.id, body);

  if (resolving) {
    ok(`Тикет отмечен как решённый → ${ticket.url}`);
    log('Диалог завершён.');
    console.log('');
    break;
  }

  ok(`Уточнение отправлено → ${ticket.url}`);
  log('Жду следующего ответа...\n');
}
