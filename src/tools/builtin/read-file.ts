import { readFile } from 'fs/promises';
import path from 'path';
import type { Tool } from '../base.js';

export const readFileTool: Tool = {
  name: 'read_file',
  description: 'Read the contents of a file. Path is relative to the current working directory.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'File path relative to cwd',
      },
    },
    required: ['path'],
  },
  requiresConfirmation: false,
  async execute(params) {
    const filePath = path.resolve(process.cwd(), params.path as string);
    const content = await readFile(filePath, 'utf-8');
    return content;
  },
};
