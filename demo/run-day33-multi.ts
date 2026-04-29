#!/usr/bin/env tsx
/**
 * День 33 — Multi-agent runner
 *
 * Запускает 1 support agent + 2 user agent параллельно.
 * Каждый user agent — отдельный пользователь со своим тикетом.
 *
 * Usage:
 *   npm run demo:day33
 */

import { spawn } from 'child_process';
import { createInterface } from 'readline';
import { fileURLToPath } from 'url';
import path from 'path';

const __dirname = path.dirname(fileURLToPath(import.meta.url));

const c = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  green: '\x1b[32m', blue: '\x1b[34m', magenta: '\x1b[35m', yellow: '\x1b[33m',
};

console.log('');
console.log(`${c.bold}╔══════════════════════════════════════════════╗${c.reset}`);
console.log(`${c.bold}║   День 33 — Multi-Agent Support Demo         ║${c.reset}`);
console.log(`${c.bold}║   ${c.blue}[SUPPORT]${c.reset}${c.bold} + ${c.magenta}[АЛЕКСЕЙ]${c.reset}${c.bold}                        ║${c.reset}`);
console.log(`${c.bold}╚══════════════════════════════════════════════╝${c.reset}`);
console.log('');

interface AgentConfig {
  script: string;
  args: string[];
  label: string;
  color: string;
}

const agents: AgentConfig[] = [
  {
    script: 'support-agent-day33.ts',
    args: [],
    label: 'SUPPORT',
    color: c.blue,
  },
  {
    script: 'user-agent-day33.ts',
    args: ['--name', 'Алексей'],
    label: 'АЛЕКСЕЙ',
    color: c.magenta,
  },
];

// Delay user agents so support agent has time to index docs
const AGENT_DELAYS_MS = [0, 5000];

const procs = agents.map(({ script, args, label, color }, i) => {
  const delay = AGENT_DELAYS_MS[i] ?? 0;

  const proc = spawn('tsx', [path.join(__dirname, script), ...args], {
    env: { ...process.env, FORCE_COLOR: '0' },
    stdio: ['ignore', 'pipe', 'pipe'],
  });

  const prefix = `${color}${c.bold}[${label}]${c.reset}`;

  setTimeout(() => {
    const rl = createInterface({ input: proc.stdout });
    rl.on('line', (line) => {
      const stripped = line.replace(/\x1b\[[0-9;]*m/g, '').trim();
      if (!stripped) { console.log(''); return; }
      console.log(`${prefix} ${line}`);
    });
  }, delay);

  proc.stderr.on('data', (data: Buffer) => {
    const text = data.toString().trim();
    if (text) console.error(`${prefix} ${c.dim}${text}${c.reset}`);
  });

  proc.on('exit', (code) => {
    console.log(`${prefix} ${code === 0 ? c.green : c.dim}завершён (${code})${c.reset}`);
  });

  return proc;
});

// Graceful shutdown
function shutdown() {
  console.log(`\n${c.dim}Останавливаю агентов...${c.reset}`);
  for (const p of procs) p.kill('SIGTERM');
  setTimeout(() => process.exit(0), 500);
}
process.on('SIGINT', shutdown);
process.on('SIGTERM', shutdown);

await Promise.all(procs.map(p => new Promise<void>(resolve => p.on('exit', () => resolve()))));
console.log(`\n${c.green}${c.bold}✓ Демонстрация завершена${c.reset}\n`);
