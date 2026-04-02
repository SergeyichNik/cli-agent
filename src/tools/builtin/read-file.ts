import { readFile } from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext } from '../base.js';

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file. Path is relative to the sandbox directory.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'File path relative to sandbox dir' },
    },
    required: ['path'],
  },
  requiresConfirmation: false,
  async execute(params, context: ToolContext) {
    const filePath = path.resolve(context.sandboxDir, params.path as string);
    return readFile(filePath, 'utf-8');
  },
};
