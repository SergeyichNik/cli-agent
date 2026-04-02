import { exec } from 'child_process';
import { promisify } from 'util';
import type { Tool, ToolContext } from '../base.js';

const execAsync = promisify(exec);

const BLACKLIST = [
  /rm\s+-[rf]{1,2}\s+\//,
  /rm\s+-[rf]{1,2}\s+~/,
  /rm\s+-[rf]{1,2}\s+\*/,
  /\bsudo\b/,
  /\bdd\b.*\bof=/,
  /\bmkfs\b/,
  />\s*\/dev\//,
  /:\(\)\s*\{/,
  /chmod\s+[0-7]*7[0-7]*\s+\//,
];

export function checkBlacklist(command: string): string | null {
  for (const pattern of BLACKLIST) {
    if (pattern.test(command)) {
      return `Command blocked by safety blacklist (matched: ${pattern})`;
    }
  }
  return null;
}

export const shellTool: Tool = {
  name: 'shell',
  description: 'Execute a shell command inside the sandbox directory. Requires user confirmation.',
  parameters: {
    type: 'object',
    properties: {
      command: { type: 'string', description: 'Shell command to execute' },
      timeout_ms: { type: 'number', description: 'Timeout in milliseconds (default: 30000)' },
    },
    required: ['command'],
  },
  requiresConfirmation: true,
  async execute(params, context: ToolContext) {
    const command = params.command as string;
    const timeout = (params.timeout_ms as number) ?? 30000;

    const violation = checkBlacklist(command);
    if (violation) throw new Error(violation);

    const { stdout, stderr } = await execAsync(command, {
      cwd: context.sandboxDir,
      timeout,
    });

    return [stdout, stderr].filter(Boolean).join('\n') || '(no output)';
  },
};
