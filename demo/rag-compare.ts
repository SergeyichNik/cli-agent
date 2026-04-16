#!/usr/bin/env tsx
/**
 * RAG Demo — День 24: Цитаты, источники и анти-галлюцинации
 *
 * Требует предварительной индексации: npm run demo:index
 *
 * Usage:
 *   tsx demo/rag-compare.ts "Кто CEO ОсьминогСофт?"   # один вопрос
 *   tsx demo/rag-compare.ts                            # автопрогон всех вопросов
 *
 * npm scripts:
 *   npm run demo:rag         -- "вопрос"
 */

import path from 'path';
import * as clack from '@clack/prompts';
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

const TOP_K_BEFORE = 15;   // кандидаты до фильтрации
const TOP_K_AFTER  = 5;    // финальный контекст после фильтрации
const MIN_SCORE    = 0.50; // порог отсечения

// ---------------------------------------------------------------------------
// ANSI colors
// ---------------------------------------------------------------------------

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  blue:   '\x1b[34m',
  gray:   '\x1b[90m',
  white:  '\x1b[97m',
};

function scoreColor(score: number): string {
  if (score >= 0.70) return c.green;
  if (score >= 0.50) return c.yellow;
  return c.red;
}

// ---------------------------------------------------------------------------
// Системный промпт: обязательные источники, цитаты, режим "не знаю"
// ---------------------------------------------------------------------------

const SYSTEM_PROMPT = `Ты — ассистент, отвечающий строго по предоставленному контексту.

Правила:
1. Если в контексте есть ответ — отвечай по нему.
2. В тексте ответа ставь inline-ссылки [1], [2] и т.д. на использованные чанки.
3. После ответа ОБЯЗАТЕЛЬНО выведи раздел "Источники:" — пронумерованный список с точной цитатой из каждого использованного чанка.
4. Если контекст не содержит ответа на вопрос — напиши "Не знаю." и попроси уточнить вопрос.
5. Никогда не придумывай факты сверх того, что есть в контексте.

Формат ответа:
<ответ с inline-ссылками [N]>

Источники:
[N] <source> § <section> — "<точная цитата из чанка>"`;

// ---------------------------------------------------------------------------
// Parse CLI args
// ---------------------------------------------------------------------------

const rawArgs = process.argv.slice(2);
const singleQuestion = rawArgs.join(' ').trim();

// ---------------------------------------------------------------------------
// Вопросы для автопрогона
// ---------------------------------------------------------------------------

const ALL_QUESTIONS = [
  'Что такое КальмарКоин и как он используется для зарплаты?',
  'Как работает телепатический компилятор в ОсьминогСофт?',
  'Кто такой Геннадий Щупальцев?',
  'Что такое компот из антарктического криля?',
  'Как работает Brainfuck с патчем от 2031 года?',
  'Где работает белка-аналитик и что она делает?',
  'Что такое нейросеть на пчёлах и как она работает?',
  'Что поют сотрудники ПингвинТех на каждом деплое?',
  'Как добраться до Атлантиды на подводном трамвае?',
  'Кто такой Прокопий Берложников и почему ушёл?',
  'Какой курс доллара к рублю на сегодня?',
  'Как приготовить классический борщ?',
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
  clack.log.error('Индекс пуст. Сначала запусти: npm run demo:index');
  process.exit(1);
}

// ---------------------------------------------------------------------------
// Stream LLM response — spinner until first token, then raw stream
// ---------------------------------------------------------------------------

async function streamAnswer(question: string, context: string): Promise<void> {
  const messages: Message[] = [
    { role: 'system', content: SYSTEM_PROMPT },
    { role: 'user', content: `Контекст:\n\n${context}\n\nВопрос: ${question}` },
  ];

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIdx = 0;
  const spinInterval = setInterval(() => {
    process.stdout.write(`\r${c.cyan}${frames[frameIdx++ % frames.length]}${c.reset} Генерирую ответ...`);
  }, 80);

  let firstToken = true;
  let inSources = false;
  let lineBuf = '';

  function flushLine(line: string): void {
    if (/^Источники:/.test(line)) {
      inSources = true;
      process.stdout.write(`\n${c.bold}${c.cyan}${line}${c.reset}\n`);
    } else if (inSources && /^\[\d+\]/.test(line)) {
      // [N] source § section — "цитата"
      const colored = line
        .replace(/^(\[\d+\])/, `${c.bold}${c.blue}$1${c.reset}`)
        .replace(/(§[^—]*)/, `${c.dim}$1${c.reset}`)
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
      // построчная буферизация для подсветки источников
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
}

// ---------------------------------------------------------------------------
// Обработка одного вопроса
// ---------------------------------------------------------------------------

async function runQuestion(question: string, idx?: number, total?: number): Promise<void> {
  const prefix = idx !== undefined ? `${c.gray}[${idx}/${total}]${c.reset} ` : '';
  console.log(`\n${c.bold}${c.cyan}?${c.reset} ${prefix}${c.white}${c.bold}${question}${c.reset}`);

  // Эмбеддинг с spinner
  const embedSpin = clack.spinner();
  embedSpin.start('Ищу в индексе...');
  const [queryEmbedding] = await embProvider.embed([question]);
  const allResults = db.search(new Float32Array(queryEmbedding), TOP_K_BEFORE);
  const filtered = allResults.filter(r => r.score >= MIN_SCORE).slice(0, TOP_K_AFTER);
  embedSpin.stop(`Найдено ${c.bold}${filtered.length}${c.reset} релевантных чанков из ${allResults.length} кандидатов`);

  // Метаданные чанков
  const scoreLines = allResults.slice(0, 5).map(r => {
    const col = scoreColor(r.score);
    const parts = r.source.replace(/^demo\/kb\//, '').split('/');
    const name = parts.length >= 2 ? `${parts[parts.length - 2]}/${parts[parts.length - 1]}` : r.source;
    const passed = r.score >= MIN_SCORE ? '' : ` ${c.gray}(отфильтрован)${c.reset}`;
    return `  ${col}${r.score.toFixed(3)}${c.reset}  ${c.dim}${name}${c.reset}${passed}`;
  });
  clack.note(scoreLines.join('\n'), 'Топ-5 по релевантности');

  // Уровень 1: нет чанков — не вызываем LLM
  if (filtered.length === 0) {
    clack.log.warn('Не знаю. Нет релевантного контекста — уточните вопрос.');
    return;
  }

  // Формат контекста с метаданными для цитирования (score не передаётся LLM)
  const context = filtered
    .map((r, i) => [
      `[${i + 1}] source: ${r.source}${r.section ? ` | section: ${r.section}` : ''} | id: ${r.id}`,
      r.content,
    ].join('\n'))
    .join('\n\n---\n\n');

  // Уровень 2: LLM сам решает "не знаю" если контекст не содержит ответа
  await streamAnswer(question, context);
}

// ---------------------------------------------------------------------------
// Один вопрос или автопрогон
// ---------------------------------------------------------------------------

if (singleQuestion) {
  clack.intro('RAG + Citations');
  await runQuestion(singleQuestion);
  clack.outro('Готово.');
} else {
  clack.intro(`RAG + Citations — автопрогон ${ALL_QUESTIONS.length} вопросов`);
  for (let i = 0; i < ALL_QUESTIONS.length; i++) {
    await runQuestion(ALL_QUESTIONS[i], i + 1, ALL_QUESTIONS.length);
  }
  clack.outro('Готово.');
}
