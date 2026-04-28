#!/usr/bin/env tsx
/**
 * RAG Chat — День 25: Мини-чат с RAG + памятью задачи
 *
 * Требует предварительной индексации: npm run demo:index
 *
 * Usage:
 *   npm run demo:chat              # интерактивный режим
 *   npm run demo:chat:scenario     # автопрогон 14 сообщений
 */

import path from 'path';
import readline from 'readline';
import { SearchDB } from '../mcp-servers/search/db.js';
import { createProvider as createEmbeddingProvider, type EmbeddingConfig } from '../mcp-servers/search/embeddings.js';
import { loadProjectConfig } from '../src/agent/config.js';
import { loadSecrets } from '../src/agent/secrets.js';
import { DeepSeekProvider } from '../src/providers/deepseek.js';
import { LMStudioProvider } from '../src/providers/lmstudio.js';
import type { Message } from '../src/providers/base.js';

// ---------------------------------------------------------------------------
// Config
// ---------------------------------------------------------------------------

const TOP_K_BEFORE = 15;
const TOP_K_AFTER  = 5;
const MIN_SCORE    = 0.45;

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const c = {
  reset:   '\x1b[0m',
  bold:    '\x1b[1m',
  dim:     '\x1b[2m',
  green:   '\x1b[32m',
  yellow:  '\x1b[33m',
  cyan:    '\x1b[36m',
  blue:    '\x1b[34m',
  gray:    '\x1b[90m',
  white:   '\x1b[97m',
  magenta: '\x1b[35m',
};

// ---------------------------------------------------------------------------
// Task Memory
// ---------------------------------------------------------------------------

interface TaskMemory {
  goal: string;
  constraints: string[];
  clarifications: Record<string, string>;
}

let taskMemory: TaskMemory = { goal: '', constraints: [], clarifications: {} };
let phase: 'planning' | 'execution' | 'validation' = 'planning';

function mergeTaskMemory(update: Partial<TaskMemory>): void {
  if (update.goal) taskMemory.goal = update.goal;
  if (Array.isArray(update.constraints) && update.constraints.length > 0) {
    taskMemory.constraints = [...new Set([...taskMemory.constraints, ...update.constraints])];
  }
  if (update.clarifications && Object.keys(update.clarifications).length > 0) {
    taskMemory.clarifications = { ...taskMemory.clarifications, ...update.clarifications };
  }
}

function parseTaskMemoryFromText(text: string): Partial<TaskMemory> | null {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (!trimmed.startsWith('{') || !trimmed.includes('"task_memory"')) continue;
    try {
      const obj = JSON.parse(trimmed) as { task_memory?: Partial<TaskMemory> };
      if (obj.task_memory) return obj.task_memory;
    } catch {
      // not valid single-line JSON
    }
  }
  return null;
}

function stripTaskMemoryJson(text: string): string {
  return text
    .split('\n')
    .filter(line => {
      const t = line.trim();
      if (!t.startsWith('{') || !t.includes('"task_memory"')) return true;
      try { JSON.parse(t); return false; } catch { return true; }
    })
    .join('\n')
    .trimEnd();
}

function showTaskMemoryBar(): void {
  const hasGoal = taskMemory.goal.length > 0;
  const hasFocus = taskMemory.constraints.length > 0;
  const hasClars = Object.keys(taskMemory.clarifications).length > 0;
  if (!hasGoal && !hasFocus && !hasClars) return;

  const phaseLabel = phase === 'planning' ? 'планирование' : phase === 'execution' ? 'исполнение' : 'итог';
  const width = 56;
  const header = `─ Память задачи [${phaseLabel}] `;
  const dashes = '─'.repeat(Math.max(0, width - header.length));

  console.log(`\n${c.gray}┌${header}${dashes}┐${c.reset}`);
  if (hasGoal) {
    const goal = taskMemory.goal.length > 48 ? taskMemory.goal.slice(0, 45) + '...' : taskMemory.goal;
    console.log(`${c.gray}│${c.reset} ${c.bold}Цель:${c.reset} ${c.dim}${goal}${c.reset}`);
  }
  if (hasFocus) {
    for (const constraint of taskMemory.constraints) {
      const truncated = constraint.length > 50 ? constraint.slice(0, 47) + '...' : constraint;
      console.log(`${c.gray}│${c.reset} ${c.bold}Ограничение:${c.reset} ${c.yellow}${truncated}${c.reset}`);
    }
  }
  if (hasClars) {
    for (const [term, value] of Object.entries(taskMemory.clarifications)) {
      const pair = `"${term}" → ${value}`;
      const truncated = pair.length > 50 ? pair.slice(0, 47) + '...' : pair;
      console.log(`${c.gray}│${c.reset} ${c.bold}Термин:${c.reset} ${c.cyan}${truncated}${c.reset}`);
    }
  }
  console.log(`${c.gray}└${'─'.repeat(width)}┘${c.reset}`);
}

// ---------------------------------------------------------------------------
// System prompt
// ---------------------------------------------------------------------------

function buildSystemPrompt(): string {
  const mem = taskMemory;
  const hasFilter = mem.constraints.length > 0;
  const hasClars = Object.keys(mem.clarifications).length > 0;

  let memBlock = '';
  if (mem.goal || hasFilter || hasClars) {
    memBlock = `\n\nТекущая память задачи:\n`;
    if (mem.goal) memBlock += `- Цель: ${mem.goal}\n`;
    if (hasFilter) memBlock += `- Ограничения по темам: ${mem.constraints.join('; ')}\n`;
    if (hasClars) {
      const pairs = Object.entries(mem.clarifications).map(([k, v]) => `"${k}" = ${v}`).join('; ');
      memBlock += `- Термины: ${pairs}\n`;
    }
  }

  return `Ты — ассистент, отвечающий строго по предоставленному контексту.${memBlock}

Правила:
1. Если в контексте есть ответ — отвечай по нему с inline-ссылками [1], [2] и т.д.
2. После ответа выведи раздел "Источники:" — компактный список:
   [N] <имя_файла> — "<точная короткая цитата>"
3. Если контекст не содержит ответа — напиши "Не знаю." и предложи переформулировать.
4. Никогда не придумывай факты сверх контекста.
5. ОГРАНИЧЕНИЯ ПО ТЕМАМ: если в памяти задачи есть ограничения (constraints) — вежливо откажи
   отвечать на вопросы вне этих тем. Пример: если constraints = ["только технологии"], то на
   вопрос о дресс-коде ответь: "Эта тема за пределами нашего фокуса (только технологии)."
6. ТЕРМИНЫ: если в памяти задачи есть уточнения терминов (clarifications) — применяй их при
   неоднозначных вопросах. Пример: если "компания" = ОсьминогСофт, то на вопрос
   "сколько человек в компании?" отвечай про ОсьминогСофт и укажи что применил уточнение.
7. В самом конце ответа ОБЯЗАТЕЛЬНО выведи одну строку JSON с обновлением памяти задачи:
   {"task_memory": {"goal": "...", "constraints": ["..."], "clarifications": {"термин": "значение"}}}
   - goal: ТЕКУЩАЯ цель пользователя — обновляй при смене направления разговора
   - constraints: активные ограничения по темам, заданные пользователем явно
   - clarifications: термины с их значениями, уточнённые пользователем явно
   Обновляй кумулятивно, не сбрасывай предыдущие данные.

Формат ответа:
<текст с [N]>

Источники:
[N] <файл> — "<цитата>"

{"task_memory": {"goal": "...", "constraints": [...], "clarifications": {...}}}`;
}

// ---------------------------------------------------------------------------
// Scenario (14 сообщений)
// ---------------------------------------------------------------------------

const SCENARIO: string[] = [
  // --- Фаза 1: знакомство с ОсьминогСофт ---
  'Расскажи мне про ОсьминогСофт',
  'Кто там CEO?',
  'А что за КальмарКоин?',
  'Как он используется для зарплаты сотрудников?',
  // --- Фаза 2: расширение на другие компании ---
  'Расскажи про ПингвинТех',
  'Что поют на каждом деплое?',
  'Белка-аналитик — это кто?',
  'Сравни ОсьминогСофт и ПингвинТех',
  // --- Фаза 3: явные ограничения и термины ---
  'Давай сузим тему: отвечай только на вопросы про технологии и стек. Вопросы про культуру, HR и офис — пропускай',
  'И ещё уточнение: когда говорю "компания" без названия — имею в виду ОсьминогСофт',
  // --- Тест ограничений ---
  'Какой дресс-код в компании?',           // должен отказать (культура — вне фокуса) и использовать "компания"=ОсьминогСофт
  'Сколько человек работает в компании?',  // должен применить "компания"=ОсьминогСофт → 8 сотрудников
  // --- Фаза 4: продолжение в фокусе ---
  'Телепатический компилятор — как работает?',
  'Кто такой Геннадий Щупальцев и почему важен?',
  'Подведи итог: что я узнал про компанию?',
];

// ---------------------------------------------------------------------------
// Setup: config, secrets, LLM, embeddings, DB
// ---------------------------------------------------------------------------

const projectRoot = process.cwd();
const dbPath = path.join(projectRoot, '.agent', 'data', 'search.db');

const config = loadProjectConfig(projectRoot);
const secrets = loadSecrets();

const apiKey =
  secrets[config.provider]?.apiKey ??
  (config.provider === 'deepseek' ? process.env.DEEPSEEK_API_KEY : undefined);
const lmStudioUrl = secrets.lmstudio?.baseUrl ?? process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1';
const deepSeekUrl = secrets.deepseek?.baseUrl ?? process.env.DEEPSEEK_BASE_URL;

const llm =
  config.provider === 'deepseek'
    ? new DeepSeekProvider(apiKey ?? '', config.model, deepSeekUrl)
    : new LMStudioProvider(config.model, lmStudioUrl);

const e = config.embeddingProvider;
const embProvider = createEmbeddingProvider({
  type: e?.type ?? 'ollama', model: e?.model, url: e?.url, apiKey: e?.apiKey,
} as EmbeddingConfig);

const db = new SearchDB(dbPath);

if (db.getIndexedSources().length === 0) {
  console.error(`\n${c.yellow}Индекс пуст. Сначала запусти: npm run demo:index${c.reset}\n`);
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Stream + collect full text
// ---------------------------------------------------------------------------

async function streamAndCollect(messages: Message[]): Promise<string> {
  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIdx = 0;
  const spinInterval = setInterval(() => {
    process.stdout.write(`\r${c.cyan}${frames[frameIdx++ % frames.length]}${c.reset} Генерирую ответ...`);
  }, 80);

  let firstToken = true;
  let fullText = '';
  let lineBuf = '';
  let inSources = false;

  function flushLine(line: string): void {
    // hide task_memory JSON line from display
    const trimmed = line.trim();
    if (trimmed.startsWith('{') && trimmed.includes('"task_memory"')) {
      try { JSON.parse(trimmed); return; } catch { /* show it */ }
    }

    if (/^Источники:/.test(line)) {
      inSources = true;
      process.stdout.write(`\n${c.bold}${c.cyan}${line}${c.reset}\n`);
    } else if (inSources && /^\[\d+\]/.test(line)) {
      const colored = line
        .replace(/^(\[\d+\])/, `${c.bold}${c.blue}$1${c.reset}`)
        .replace(/"([^"]*)"/, `${c.yellow}"$1"${c.reset}`);
      process.stdout.write(colored + '\n');
    } else {
      process.stdout.write(line + '\n');
    }
  }

  for await (const chunk of llm.stream(messages, { temperature: 0.3 })) {
    if (chunk.type === 'text') {
      if (firstToken) {
        clearInterval(spinInterval);
        process.stdout.write('\r\x1b[K\n');
        firstToken = false;
      }
      fullText += chunk.text;
      lineBuf += chunk.text;
      const lines = lineBuf.split('\n');
      lineBuf = lines.pop() ?? '';
      for (const line of lines) flushLine(line);
    }
  }

  if (firstToken) {
    clearInterval(spinInterval);
    process.stdout.write('\r\x1b[K');
  } else {
    if (lineBuf) flushLine(lineBuf);
    process.stdout.write('\n');
  }

  return fullText;
}

// ---------------------------------------------------------------------------
// Intent classification: question vs instruction
// ---------------------------------------------------------------------------

type MessageIntent = 'question' | 'instruction';

function classifyIntent(message: string): MessageIntent {
  const lower = message.toLowerCase();
  const instructionPatterns = [
    /отвечай только/,
    /не отвечай/,
    /пропускай/,
    /фокусируйся только/,
    /сузим тему/,
    /сузи тему/,
    /когда говорю/,
    /имею в виду/,
    /запомни[,: ]/,
    /забудь/,
    /теперь только/,
    /ограничение:/,
    /уточнение:/,
    /под словом/,
    /термин:/,
  ];
  return instructionPatterns.some(p => p.test(lower)) ? 'instruction' : 'question';
}

// ---------------------------------------------------------------------------
// System prompt for instruction acknowledgment (no RAG)
// ---------------------------------------------------------------------------

function buildInstructionPrompt(): string {
  const memJson = JSON.stringify(taskMemory);
  return `Пользователь дал тебе инструкцию (не вопрос). Текущая память задачи: ${memJson}

Твои действия:
1. Подтверди что понял инструкцию — напиши "Понял. [одно предложение: что именно запомнил или изменил]"
2. НЕ выводи раздел "Источники:" — источники не нужны для инструкций
3. Выведи одну строку JSON с обновлённой памятью задачи:
   {"task_memory": {"goal": "...", "constraints": ["..."], "clarifications": {"термин": "значение"}}}
   Обновляй кумулятивно — не сбрасывай предыдущие данные.`;
}

// ---------------------------------------------------------------------------
// Dialog history (clean — no RAG context inside)
// ---------------------------------------------------------------------------

const history: Message[] = [];

// ---------------------------------------------------------------------------
// Handle instruction turn (no RAG search)
// ---------------------------------------------------------------------------

async function handleInstruction(message: string, turnIdx?: number, total?: number): Promise<void> {
  const prefix = turnIdx !== undefined ? `${c.gray}[${turnIdx}/${total}]${c.reset} ` : '';
  console.log(`\n${c.bold}${c.magenta}!${c.reset} ${prefix}${c.white}${c.bold}${message}${c.reset}`);
  console.log(`${c.dim}[инструкция — RAG не требуется]${c.reset}`);

  const messages: Message[] = [
    { role: 'system', content: buildInstructionPrompt() },
    ...history,
    { role: 'user', content: message },
  ];

  const fullText = await streamAndCollect(messages);

  const memUpdate = parseTaskMemoryFromText(fullText);
  if (memUpdate) mergeTaskMemory(memUpdate);

  const cleanAnswer = stripTaskMemoryJson(fullText);
  history.push({ role: 'user', content: message });
  history.push({ role: 'assistant', content: cleanAnswer });
}

// ---------------------------------------------------------------------------
// Handle question turn (with RAG search)
// ---------------------------------------------------------------------------

async function handleQuestion(question: string, turnIdx?: number, total?: number): Promise<void> {
  const prefix = turnIdx !== undefined ? `${c.gray}[${turnIdx}/${total}]${c.reset} ` : '';
  console.log(`\n${c.bold}${c.cyan}?${c.reset} ${prefix}${c.white}${c.bold}${question}${c.reset}`);

  // RAG: embed → search → filter
  process.stdout.write(`${c.dim}Ищу в индексе...${c.reset}`);
  const [queryEmbedding] = await embProvider.embed([question]);
  const allResults = db.search(new Float32Array(queryEmbedding), TOP_K_BEFORE);
  const filtered = allResults.filter(r => r.score >= MIN_SCORE).slice(0, TOP_K_AFTER);
  const best = allResults[0]?.score.toFixed(3) ?? '—';
  process.stdout.write(`\r\x1b[K${c.dim}Найдено ${filtered.length} чанков (лучший: ${best})${c.reset}\n`);

  // No relevant context → skip LLM
  if (filtered.length === 0) {
    const noAnswer = 'Не знаю. Нет релевантного контекста — уточните вопрос.';
    console.log(`\n${c.yellow}${noAnswer}${c.reset}\n`);
    history.push({ role: 'user', content: question });
    history.push({ role: 'assistant', content: noAnswer });
    return;
  }

  // Build RAG context block
  const ragContext = filtered
    .map((r, i) => {
      const fname = r.source.split('/').pop() ?? r.source;
      const section = r.section ? ` § ${r.section}` : '';
      return `[${i + 1}] ${fname}${section}\n${r.content}`;
    })
    .join('\n\n---\n\n');

  const messages: Message[] = [
    { role: 'system', content: buildSystemPrompt() },
    ...history,
    { role: 'user', content: `Контекст:\n\n${ragContext}\n\nВопрос: ${question}` },
  ];

  const fullText = await streamAndCollect(messages);

  const memUpdate = parseTaskMemoryFromText(fullText);
  if (memUpdate) mergeTaskMemory(memUpdate);

  // Update phase
  if (phase === 'planning' && taskMemory.goal) phase = 'execution';
  const q = question.toLowerCase();
  if (q.includes('итог') || q.includes('резюм') || q.includes('подведи')) phase = 'validation';

  const cleanAnswer = stripTaskMemoryJson(fullText);
  history.push({ role: 'user', content: question });
  history.push({ role: 'assistant', content: cleanAnswer });
}

// ---------------------------------------------------------------------------
// Process one turn — dispatch by intent
// ---------------------------------------------------------------------------

async function processTurn(message: string, turnIdx?: number, total?: number): Promise<void> {
  const intent = classifyIntent(message);
  if (intent === 'instruction') {
    await handleInstruction(message, turnIdx, total);
  } else {
    await handleQuestion(message, turnIdx, total);
  }
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const isScenario = process.argv.includes('--scenario');

console.log(`\n${c.bold}${c.cyan}╔════════════════════════════════════════╗${c.reset}`);
console.log(`${c.bold}${c.cyan}║  RAG Chat + Память задачи  —  День 25  ║${c.reset}`);
console.log(`${c.bold}${c.cyan}╚════════════════════════════════════════╝${c.reset}`);

if (isScenario) {
  console.log(`\n${c.dim}Режим: автосценарий (${SCENARIO.length} сообщений)${c.reset}`);

  for (let i = 0; i < SCENARIO.length; i++) {
    await processTurn(SCENARIO[i], i + 1, SCENARIO.length);
    showTaskMemoryBar();
    if (i < SCENARIO.length - 1) {
      // small pause between turns for readability in scenario mode
      await new Promise(r => setTimeout(r, 300));
    }
  }

  console.log(`\n${c.bold}${c.green}Сценарий завершён. История: ${history.length / 2} сообщений.${c.reset}\n`);
} else {
  console.log(`\n${c.dim}Режим: интерактивный. Введите вопрос или ${c.bold}exit${c.reset}${c.dim} для выхода.${c.reset}`);

  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });

  const askNext = (): void => {
    showTaskMemoryBar();
    rl.question(`\n${c.bold}${c.green}>${c.reset} `, async (input) => {
      const q = input.trim();
      if (!q || q === 'exit' || q === 'quit') {
        console.log(`\n${c.dim}До свидания. История: ${history.length / 2} сообщений.${c.reset}\n`);
        rl.close();
        return;
      }
      await processTurn(q);
      askNext();
    });
  };

  askNext();
}
