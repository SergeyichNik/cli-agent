import { writeFile, mkdir } from 'fs/promises';
import path from 'path';
import type { Tool } from '../base.js';

export const writeFileTool: Tool = {
  name: 'write_file',
  description: 'Write content to a file. Creates parent directories if needed. Requires user confirmation.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to cwd',
      },
      content: {
        type: 'string',
        description: 'Content to write',
      },
    },
    required: ['path', 'content'],
  },
  requiresConfirmation: true,
  async execute(params) {
    const filePath = path.resolve(process.cwd(), params.path as string);
    const cwd = process.cwd();

    // Scope invariant: no writes outside cwd tree
    if (!filePath.startsWith(cwd + path.sep) && filePath !== cwd) {
      throw new Error(`write_file: path ${filePath} is outside working directory ${cwd}`);
    }

    await mkdir(path.dirname(filePath), { recursive: true });
    await writeFile(filePath, params.content as string, 'utf-8');
    return `Written ${(params.content as string).length} bytes to ${params.path}`;
  },
};
