import { readdir, stat } from 'fs/promises';
import path from 'path';
import type { Tool, ToolContext } from '../base.js';

export const listDirTool: Tool = {
  name: 'list_dir',
  description: 'List files and directories. Path is relative to the sandbox directory.',
  parameters: {
    type: 'object',
    properties: {
      path: { type: 'string', description: 'Directory path relative to sandbox dir (default: ".")' },
    },
    required: [],
  },
  requiresConfirmation: false,
  async execute(params, context: ToolContext) {
    const dirPath = path.resolve(context.sandboxDir, (params.path as string) ?? '.');
    const entries = await readdir(dirPath);
    const lines = await Promise.all(
      entries.map(async (name) => {
        const s = await stat(path.join(dirPath, name));
        return `${s.isDirectory() ? 'd' : 'f'} ${name}`;
      }),
    );
    return lines.join('\n');
  },
};
