import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { readFile, writeFile, unlink, readdir, mkdir, rename, access, copyFile, stat } from 'fs/promises';
import path from 'path';

const sandboxDir = path.resolve(process.cwd(), process.env.SANDBOX_DIR ?? './sandbox');

function resolveSafe(filePath: string): string {
  const resolved = path.resolve(sandboxDir, filePath);
  const sep = path.sep;
  if (resolved !== sandboxDir && !resolved.startsWith(sandboxDir + sep)) {
    throw new Error(`Path escapes sandbox: "${filePath}" (sandbox: ${sandboxDir})`);
  }
  return resolved;
}

const server = new McpServer({ name: 'files', version: '1.0.0' });

server.registerTool('read_file', {
  description: 'Read the contents of a file inside the sandbox directory.',
  inputSchema: {
    path: z.string().describe('File path relative to sandbox directory'),
  },
}, async ({ path: filePath }) => {
  const resolved = resolveSafe(filePath);
  const content = await readFile(resolved, 'utf-8');
  return { content: [{ type: 'text' as const, text: content }] };
});

server.registerTool('write_file', {
  description: 'Write content to a file inside the sandbox. Creates parent directories if needed.',
  inputSchema: {
    path: z.string().describe('File path relative to sandbox directory'),
    content: z.string().describe('Content to write'),
  },
}, async ({ path: filePath, content }) => {
  const resolved = resolveSafe(filePath);
  await mkdir(path.dirname(resolved), { recursive: true });
  await writeFile(resolved, content, 'utf-8');
  return { content: [{ type: 'text' as const, text: `Written ${content.length} bytes to ${filePath}` }] };
});

server.registerTool('delete_file', {
  description: 'Delete a file inside the sandbox directory.',
  inputSchema: {
    path: z.string().describe('File path relative to sandbox directory'),
  },
}, async ({ path: filePath }) => {
  const resolved = resolveSafe(filePath);
  await unlink(resolved);
  return { content: [{ type: 'text' as const, text: `Deleted ${filePath}` }] };
});

server.registerTool('list_directory', {
  description: 'List files and directories inside a sandbox directory path.',
  inputSchema: {
    path: z.string().describe('Directory path relative to sandbox (use "." for sandbox root)'),
  },
}, async ({ path: dirPath }) => {
  const resolved = resolveSafe(dirPath);
  const entries = await readdir(resolved, { withFileTypes: true });
  const lines = entries.map((e) => `${e.isDirectory() ? '[dir] ' : '[file]'} ${e.name}`);
  return { content: [{ type: 'text' as const, text: lines.join('\n') || '(empty)' }] };
});

server.registerTool('create_directory', {
  description: 'Create a directory (and any missing parents) inside the sandbox.',
  inputSchema: {
    path: z.string().describe('Directory path relative to sandbox'),
  },
}, async ({ path: dirPath }) => {
  const resolved = resolveSafe(dirPath);
  await mkdir(resolved, { recursive: true });
  return { content: [{ type: 'text' as const, text: `Directory created: ${dirPath}` }] };
});

server.registerTool('move_file', {
  description: 'Move or rename a file or directory inside the sandbox.',
  inputSchema: {
    src: z.string().describe('Source path relative to sandbox'),
    dest: z.string().describe('Destination path relative to sandbox'),
  },
}, async ({ src, dest }) => {
  const resolvedSrc = resolveSafe(src);
  const resolvedDest = resolveSafe(dest);
  await mkdir(path.dirname(resolvedDest), { recursive: true });
  await rename(resolvedSrc, resolvedDest);
  return { content: [{ type: 'text' as const, text: `Moved ${src} → ${dest}` }] };
});

server.registerTool('file_exists', {
  description: 'Check whether a file or directory exists inside the sandbox.',
  inputSchema: {
    path: z.string().describe('Path relative to sandbox'),
  },
}, async ({ path: filePath }) => {
  const resolved = resolveSafe(filePath);
  let exists = true;
  let kind = 'unknown';
  try {
    const s = await stat(resolved);
    kind = s.isDirectory() ? 'directory' : 'file';
  } catch {
    exists = false;
  }
  const text = exists ? `exists (${kind}): ${filePath}` : `not found: ${filePath}`;
  return { content: [{ type: 'text' as const, text }] };
});

server.registerTool('copy_file', {
  description: 'Copy a file inside the sandbox.',
  inputSchema: {
    src: z.string().describe('Source file path relative to sandbox'),
    dest: z.string().describe('Destination file path relative to sandbox'),
  },
}, async ({ src, dest }) => {
  const resolvedSrc = resolveSafe(src);
  const resolvedDest = resolveSafe(dest);
  await mkdir(path.dirname(resolvedDest), { recursive: true });
  await copyFile(resolvedSrc, resolvedDest);
  return { content: [{ type: 'text' as const, text: `Copied ${src} → ${dest}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
