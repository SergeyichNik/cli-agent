import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext } from '../base.js';

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file inside the sandbox directory. Creates parent directories if needed. Requires user confirmation.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to sandbox dir' },
      content: { type: 'string', description: 'Content to write' },
    },
    required: ['path', 'content'],
  },
  requiresConfirmation: true,
  async execute(params, context: ToolContext) {
    const filePath = path.resolve(context.sandboxDir, params.path as string);

    if (!filePath.startsWith(context.sandboxDir + path.sep) && filePath !== context.sandboxDir) {
      throw new Error(`write_file: path escapes sandbox (${context.sandboxDir})`);
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, params.content as string, 'utf-8');
    return `Written ${(params.content as string).length} bytes to ${params.path}`;
  },
};
