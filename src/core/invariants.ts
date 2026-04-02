import { checkBlacklist } from '../tools/builtin/shell.js';
import path from 'path';

export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}

export function checkToolInvariants(toolName: string, params: Record<string, unknown>): void {
  if (toolName === 'shell') {
    const command = params.command as string;
    const violation = checkBlacklist(command);
    if (violation) {
      throw new InvariantViolationError(violation);
    }
  }

  if (toolName === 'write_file') {
    const filePath = path.resolve(process.cwd(), params.path as string);
    const cwd = process.cwd();
    if (!filePath.startsWith(cwd + path.sep) && filePath !== cwd) {
      throw new InvariantViolationError(
        `write_file: Cannot write outside working directory. Path: ${filePath}`,
      );
    }
  }
}
