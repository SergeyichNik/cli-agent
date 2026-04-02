import { checkBlacklist } from '../tools/builtin/shell.js';
import path from 'path';

export class InvariantViolationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'InvariantViolationError';
  }
}

export function checkToolInvariants(
  toolName: string,
  params: Record<string, unknown>,
  sandboxDir: string,
): void {
  if (toolName === 'shell') {
    const violation = checkBlacklist(params.command as string);
    if (violation) throw new InvariantViolationError(violation);
  }

  if (toolName === 'write_file') {
    const filePath = path.resolve(sandboxDir, params.path as string);
    if (!filePath.startsWith(sandboxDir + path.sep) && filePath !== sandboxDir) {
      throw new InvariantViolationError(
        `write_file: path escapes sandbox. sandbox=${sandboxDir}, path=${filePath}`,
      );
    }
  }
}
