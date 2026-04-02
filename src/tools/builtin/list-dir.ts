import { readdir, stat } from 'fs/promises';
import path from 'path';
import type { Tool } from '../base.js';

export const listDirTool: Tool = {
  name: 'list_dir',
  description: 'List files and directories at a path. Path is relative to cwd.',
  parameters: {
    type: 'object',
    properties: {
      path: {
        type: 'string',
        description: 'Directory path relative to cwd (default: ".")',
      },
    },
    required: [],
  },
  requiresConfirmation: false,
  async execute(params) {
    const dirPath = path.resolve(process.cwd(), (params.path as string) ?? '.');
    const entries = await readdir(dirPath);
    const lines = await Promise.all(
      entries.map(async (name) => {
        const full = path.join(dirPath, name);
        const s = await stat(full);
        return `${s.isDirectory() ? 'd' : 'f'} ${name}`;
      }),
    );
    return lines.join('\n');
  },
};
