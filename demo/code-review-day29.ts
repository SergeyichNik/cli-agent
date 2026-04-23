#!/usr/bin/env tsx
/**
 * День 29 — Оптимизация локальной LLM под code review
 *
 * Задача: git diff → Qwen2.5-Coder → список issues с severity.
 * Сравниваем 3 параметрических конфига × 2 промпта = 6 комбо на 3 диффах.
 * Метрика: время ответа, кол-во токенов, кол-во найденных issues.
 *
 * Квантование (ручное тестирование в LM Studio UI):
 *   Q8_0:   ~9 GB VRAM, best quality,           ~25 tok/s
 *   Q4_K_M: ~5 GB VRAM, minimal quality loss,   ~40 tok/s  ← recommended
 *   Q3_K_M: ~4 GB VRAM, noticeable degradation, ~55 tok/s
 *
 * Usage:
 *   tsx demo/code-review-day29.ts           # бенчмарк всех комбо (1 тестовый diff)
 *   tsx demo/code-review-day29.ts --full    # все 3 диффа × все конфиги
 *
 * npm script:
 *   npm run demo:day29
 */

import * as clack from '@clack/prompts';
import { LMStudioProvider } from '../src/providers/lmstudio.js';
import { loadSecrets } from '../src/agent/secrets.js';
import type { Message } from '../src/providers/base.js';

// ---------------------------------------------------------------------------
// ANSI
// ---------------------------------------------------------------------------

const c = {
  reset:  '\x1b[0m',
  bold:   '\x1b[1m',
  dim:    '\x1b[2m',
  green:  '\x1b[32m',
  yellow: '\x1b[33m',
  red:    '\x1b[31m',
  cyan:   '\x1b[36m',
  gray:   '\x1b[90m',
  white:  '\x1b[97m',
  blue:   '\x1b[34m',
};

// ---------------------------------------------------------------------------
// Параметрические конфиги (A/B тест)
// ---------------------------------------------------------------------------

interface ReviewConfig {
  name: string;
  temperature: number;
  maxTokens?: number;
  label: string;
}

const CONFIGS: ReviewConfig[] = [
  { name: 'baseline', temperature: 0.3, maxTokens: undefined, label: 'Baseline (day28 defaults)' },
  { name: 'precise',  temperature: 0.1, maxTokens: 1024,      label: 'Precise  temp=0.1 max=1024' },
  { name: 'creative', temperature: 0.5, maxTokens: 2048,      label: 'Creative temp=0.5 max=2048' },
];

// ---------------------------------------------------------------------------
// Промпты (до / после оптимизации)
// ---------------------------------------------------------------------------

const PROMPT_SIMPLE = `You are a code reviewer. Review the following git diff and find bugs and suggest improvements. Be concise.`;

const PROMPT_COT = `You are a senior code reviewer. Work step by step:
1. Identify what changed (files, functions, logic)
2. For each change: check for bugs, edge cases, type errors, missing error handling
3. Suggest concrete improvements with severity markers:
   🔴 critical — must fix before merge
   🟡 warning  — should fix, potential bug
   🟢 suggestion — nice to have
4. End with a one-line summary: "N issues found (X critical, Y warnings, Z suggestions)"`;

const PROMPTS = [
  { name: 'simple', label: 'Simple',          system: PROMPT_SIMPLE },
  { name: 'cot',    label: 'Chain-of-thought', system: PROMPT_COT   },
];

// ---------------------------------------------------------------------------
// Тестовые диффы
// ---------------------------------------------------------------------------

// Diff 1: реальный — добавление lmstudio local mode в agent/config (commit f8f0041)
const DIFF_REAL_CONFIG = `diff --git a/src/agent/config.ts b/src/agent/config.ts
index 44f10f2..57917d8 100644
--- a/src/agent/config.ts
+++ b/src/agent/config.ts
@@ -8,8 +8,10 @@ export const ProjectConfigSchema = z.object({
   preferredLanguage: z.string().default('English'),
   responseStyle: z.enum(['concise', 'detailed']).default('concise'),
   contextWindowTokens: z.number().default(32000),
+  compactPrompt: z.boolean().default(false),
   maxToolDepth: z.number().default(30),
   maxToolRetries: z.number().default(3),
+  maxOutputTokens: z.number().optional(),
   invariants: z.array(z.string()).default([]),
   mcpServers: z.record(z.string(), z.string()).default({}),`;

// Diff 2: реальный — agent.ts передаёт compactPrompt и убирает tools для lmstudio
const DIFF_REAL_AGENT = `diff --git a/src/core/agent.ts b/src/core/agent.ts
index efad33e..2ce8810 100644
--- a/src/core/agent.ts
+++ b/src/core/agent.ts
@@ -39,7 +39,7 @@ export async function runAgentTurn(userMessage: string, deps: AgentDeps): Promis
   const { provider, wm, ltm, sm, tools, config, renderer, sessionId } = deps;

-  const systemPrompt = buildSystemPrompt(config, ltm, sessionId, sm.taskMachine.state, sm.taskMachine.task, tools.sandboxDir);
+  const systemPrompt = buildSystemPrompt(config, ltm, sessionId, sm.taskMachine.state, sm.taskMachine.task, tools.sandboxDir, config.compactPrompt);
   const messages = buildContext(userMessage, systemPrompt, wm, ltm, sm.taskMachine.task, sm.taskMachine.state);

   // Add user message to WM
@@ -67,8 +67,9 @@ export async function runAgentTurn(userMessage: string, deps: AgentDeps): Promis
     for await (const chunk of provider.stream(messages, {
-      tools: tools.listForLLM(),
+      tools: config.provider === 'lmstudio' ? [] : tools.listForLLM(),
       temperature: config.provider === 'lmstudio' ? 0.3 : undefined,
+      maxTokens: config.maxOutputTokens,
     }));`;

// Diff 3: синтетический — намеренные баги (null-ref, unhandled promise, wrong default)
const DIFF_SYNTHETIC_BUGS = `diff --git a/src/cache/store.ts b/src/cache/store.ts
index 000000..111111 100644
--- /dev/null
+++ b/src/cache/store.ts
@@ -0,0 +1,42 @@
+import { readFileSync, writeFileSync } from 'fs';
+
+interface CacheEntry {
+  key: string;
+  value: unknown;
+  expiresAt: number;
+}
+
+export class CacheStore {
+  private entries: Map<string, CacheEntry> = new Map();
+  private filePath: string;
+
+  constructor(filePath: string) {
+    this.filePath = filePath;
+    this.load();
+  }
+
+  private load(): void {
+    const raw = readFileSync(this.filePath, 'utf-8');
+    const data = JSON.parse(raw) as CacheEntry[];
+    data.forEach(e => this.entries.set(e.key, e));
+  }
+
+  get(key: string): unknown {
+    const entry = this.entries.get(key);
+    if (entry.expiresAt < Date.now()) {
+      this.entries.delete(key);
+      return null;
+    }
+    return entry.value;
+  }
+
+  set(key: string, value: unknown, ttlSeconds = 0): void {
+    const expiresAt = Date.now() + ttlSeconds * 1000;
+    this.entries.set(key, { key, value, expiresAt });
+    this.save();
+  }
+
+  private save(): void {
+    const data = [...this.entries.values()];
+    writeFileSync(this.filePath, JSON.stringify(data));
+  }
+}`;

const DIFFS = [
  { name: 'config-change',  label: 'Config schema (real)',        diff: DIFF_REAL_CONFIG   },
  { name: 'agent-change',   label: 'Agent turn (real)',           diff: DIFF_REAL_AGENT    },
  { name: 'cache-bugs',     label: 'CacheStore (synthetic+bugs)', diff: DIFF_SYNTHETIC_BUGS },
];

// ---------------------------------------------------------------------------
// Провайдер
// ---------------------------------------------------------------------------

const LMSTUDIO_MODEL = 'qwen2.5-coder-14b-instruct-mlx';

const secrets = loadSecrets();
const lmStudioUrl = secrets.lmstudio?.baseUrl ?? process.env.LMSTUDIO_BASE_URL ?? 'http://localhost:1234/v1';
const lmStudio = new LMStudioProvider(LMSTUDIO_MODEL, lmStudioUrl);

// ---------------------------------------------------------------------------
// Результат одного прогона
// ---------------------------------------------------------------------------

interface RunResult {
  configName: string;
  promptName: string;
  diffName: string;
  ms: number;
  outputTokens: number;
  issueCount: number;
  text: string;
}

// ---------------------------------------------------------------------------
// Счётчик issues по маркерам severity
// ---------------------------------------------------------------------------

function countIssues(text: string): number {
  const matches = text.match(/🔴|🟡|🟢|\bIssue\b|\bbug\b|\bBug\b|\bproblem\b|\bfix\b|\b\d+\.\s/gi) ?? [];
  return Math.min(matches.length, 20);
}

// ---------------------------------------------------------------------------
// Запуск одного ревью
// ---------------------------------------------------------------------------

async function runReview(
  diff: string,
  cfg: ReviewConfig,
  prompt: { name: string; system: string },
): Promise<Omit<RunResult, 'configName' | 'promptName' | 'diffName'>> {
  const messages: Message[] = [
    { role: 'system', content: prompt.system },
    { role: 'user',   content: `Review this diff:\n\`\`\`diff\n${diff}\n\`\`\`` },
  ];

  const start = Date.now();

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIdx = 0;
  const spin = setInterval(() => {
    process.stdout.write(`\r${c.cyan}${frames[frameIdx++ % frames.length]}${c.reset} Reviewing...`);
  }, 80);

  let text = '';
  let outputTokens = 0;
  let firstToken = true;

  for await (const chunk of lmStudio.stream(messages, {
    temperature: cfg.temperature,
    maxTokens: cfg.maxTokens,
  })) {
    if (chunk.type === 'text') {
      if (firstToken) {
        clearInterval(spin);
        process.stdout.write('\r\x1b[K');
        firstToken = false;
      }
      text += chunk.text;
      process.stdout.write(chunk.text);
    }
    if (chunk.type === 'usage') {
      outputTokens = chunk.output_tokens;
    }
  }

  clearInterval(spin);
  if (firstToken) process.stdout.write('\r\x1b[K');
  else process.stdout.write('\n');

  return {
    ms: Date.now() - start,
    outputTokens: outputTokens || Math.round(text.length / 4),
    issueCount: countIssues(text),
    text,
  };
}

// ---------------------------------------------------------------------------
// Таблица результатов
// ---------------------------------------------------------------------------

function printTable(results: RunResult[]): void {
  const COL = { config: 12, prompt: 7, diff: 16, ms: 8, tokens: 7, issues: 7 };

  const hr = (c1: string, c2: string, c3: string) =>
    c1 + '─'.repeat(COL.config + 2) + c2
      + '─'.repeat(COL.prompt + 2) + c2
      + '─'.repeat(COL.diff + 2) + c2
      + '─'.repeat(COL.ms + 2) + c2
      + '─'.repeat(COL.tokens + 2) + c2
      + '─'.repeat(COL.issues + 2) + c3;

  const row = (cfg: string, prm: string, dif: string, ms: string, tok: string, iss: string) =>
    `│ ${cfg.padEnd(COL.config)} │ ${prm.padEnd(COL.prompt)} │ ${dif.padEnd(COL.diff)} │ ${ms.padStart(COL.ms)} │ ${tok.padStart(COL.tokens)} │ ${iss.padStart(COL.issues)} │`;

  console.log('\n' + c.bold + c.white + '  Day 29 — Code Review Benchmark' + c.reset);
  console.log(hr('┌', '┬', '┐'));
  console.log(row('config', 'prompt', 'diff', 'time(ms)', 'tokens', 'issues'));
  console.log(hr('├', '┼', '┤'));

  let bestIssues = 0;
  let bestIdx = 0;
  results.forEach((r, i) => {
    if (r.issueCount > bestIssues) { bestIssues = r.issueCount; bestIdx = i; }
  });

  results.forEach((r, i) => {
    const marker = i === bestIdx ? ` ${c.green}←best${c.reset}` : '';
    console.log(
      row(r.configName, r.promptName, r.diffName.slice(0, COL.diff), String(r.ms), String(r.outputTokens), String(r.issueCount))
      + marker,
    );
  });

  console.log(hr('└', '┴', '┘'));
}

// ---------------------------------------------------------------------------
// Quantization notes
// ---------------------------------------------------------------------------

function printQuantNotes(): void {
  console.log('\n' + c.bold + c.yellow + '  Quantization (manual testing in LM Studio)' + c.reset);
  console.log(`  ${c.dim}Model: Qwen2.5-Coder-14B-Instruct${c.reset}`);
  console.log('');
  console.log(`  Q8_0   │ ~9 GB VRAM │ best quality          │ ~25 tok/s`);
  console.log(`  Q4_K_M │ ~5 GB VRAM │ minimal quality loss  │ ~40 tok/s  ${c.green}← recommended${c.reset}`);
  console.log(`  Q3_K_M │ ~4 GB VRAM │ noticeable degradation│ ~55 tok/s`);
  console.log('');
  console.log(`  ${c.dim}Tip: Switch model in LM Studio → load different GGUF quant file.${c.reset}`);
  console.log(`  ${c.dim}Code review tasks: Q4_K_M hits the sweet spot — fast + accurate.${c.reset}`);
}

// ---------------------------------------------------------------------------
// Main
// ---------------------------------------------------------------------------

const fullMode = process.argv.includes('--full');

clack.intro(`День 29: Code Review Benchmark — ${LMSTUDIO_MODEL}`);

const diffsToRun   = fullMode ? DIFFS : [DIFFS[2]]; // по умолчанию только синтетический (самый интересный)
const configsToRun = fullMode ? CONFIGS : [CONFIGS[0], CONFIGS[1]]; // baseline vs precise
const promptsToRun = PROMPTS; // всегда оба промпта

if (!fullMode) {
  clack.log.info(`Быстрый режим: 1 diff × ${configsToRun.length} конфига × ${promptsToRun.length} промпта = ${configsToRun.length * promptsToRun.length} прогонов`);
  clack.log.info('Добавь --full для всех 3 диффов и конфигов');
}

const results: RunResult[] = [];

for (const diff of diffsToRun) {
  console.log(`\n${c.bold}${c.blue}── Diff: ${diff.label} ──${c.reset}`);

  for (const cfg of configsToRun) {
    for (const prompt of promptsToRun) {
      console.log(`\n${c.gray}[${cfg.name} / ${prompt.name}]${c.reset} ${c.dim}temp=${cfg.temperature} maxTokens=${cfg.maxTokens ?? 'default'}${c.reset}`);

      const result = await runReview(diff.diff, cfg, prompt);
      results.push({
        configName: cfg.name,
        promptName: prompt.name,
        diffName: diff.name,
        ...result,
      });

      console.log(`${c.dim}⏱  ${result.ms}ms  |  ~${result.outputTokens} tokens  |  ${result.issueCount} issues${c.reset}`);
    }
  }
}

printTable(results);
printQuantNotes();

// Вывод победителя
const winner = results.reduce((a, b) => a.issueCount >= b.issueCount ? a : b);
console.log('\n' + c.bold + c.green + `  Оптимальная конфигурация:` + c.reset);
console.log(`  config=${winner.configName}  prompt=${winner.promptName}  →  ${winner.issueCount} issues за ${winner.ms}ms`);

clack.outro('Готово.');
