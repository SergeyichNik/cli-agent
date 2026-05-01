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

// ── Helpers for grep_files / find_files ────────────────────────────────────

function globToRegex(glob: string): RegExp {
  const regexStr = glob
    .replace(/\./g, '\\.')
    .replace(/\*\*/g, '\x00')
    .replace(/\*/g, '[^/]*')
    .replace(/\x00/g, '.*')
    .replace(/\?/g, '[^/]');
  return new RegExp(`^${regexStr}$`);
}

async function walkFiles(dir: string, results: string[] = []): Promise<string[]> {
  const entries = await readdir(dir, { withFileTypes: true });
  for (const entry of entries) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      if (entry.name === 'node_modules' || entry.name === '.git') continue;
      await walkFiles(full, results);
    } else if (entry.isFile()) {
      results.push(full);
    }
  }
  return results;
}

// ── find_files ──────────────────────────────────────────────────────────────

server.registerTool('find_files', {
  description: 'Find files matching a glob pattern inside the sandbox. Skips node_modules and .git.',
  inputSchema: {
    glob: z.string().describe('Glob pattern, e.g. "**/*.ts", "src/**/*.md", "*.json"'),
  },
}, async ({ glob }) => {
  const allFiles = await walkFiles(sandboxDir);
  const pattern = globToRegex(glob);
  const matched = allFiles
    .map((f) => path.relative(sandboxDir, f))
    .filter((rel) => pattern.test(rel))
    .sort();
  const text = matched.length
    ? matched.join('\n')
    : `No files match pattern: ${glob}`;
  return { content: [{ type: 'text' as const, text }] };
});

// ── grep_files ──────────────────────────────────────────────────────────────

server.registerTool('grep_files', {
  description: 'Search for a text or regex pattern across files in the sandbox. Returns matching lines with file path and line number.',
  inputSchema: {
    pattern: z.string().describe('Text string or regex pattern to search for'),
    glob: z.string().optional().describe('Glob filter for files to search, e.g. "**/*.ts" (default: all files)'),
    isRegex: z.boolean().optional().describe('Treat pattern as a regular expression (default: false)'),
    contextLines: z.number().optional().describe('Number of surrounding lines to include around each match (default: 0)'),
    maxResults: z.number().optional().describe('Maximum number of matching lines to return (default: 100)'),
  },
}, async ({ pattern, glob, isRegex = false, contextLines = 0, maxResults = 100 }) => {
  const allFiles = await walkFiles(sandboxDir);
  const fileFilter = glob ? globToRegex(glob) : null;
  const candidates = allFiles
    .map((f) => ({ abs: f, rel: path.relative(sandboxDir, f) }))
    .filter(({ rel }) => !fileFilter || fileFilter.test(rel));

  const searchRegex = isRegex
    ? new RegExp(pattern, 'g')
    : new RegExp(pattern.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'g');

  const output: string[] = [];
  let totalMatches = 0;

  for (const { abs, rel } of candidates) {
    if (totalMatches >= maxResults) break;
    let content: string;
    try {
      content = await readFile(abs, 'utf-8');
    } catch {
      continue; // skip binary or unreadable files
    }
    // skip likely binary files
    if (content.includes('\x00')) continue;

    const lines = content.split('\n');
    for (let i = 0; i < lines.length; i++) {
      searchRegex.lastIndex = 0;
      if (searchRegex.test(lines[i])) {
        if (totalMatches >= maxResults) break;
        const from = Math.max(0, i - contextLines);
        const to = Math.min(lines.length - 1, i + contextLines);
        for (let j = from; j <= to; j++) {
          const marker = j === i ? '>' : ' ';
          output.push(`${rel}:${j + 1}:${marker} ${lines[j]}`);
        }
        if (contextLines > 0) output.push('---');
        totalMatches++;
      }
    }
  }

  const text = output.length
    ? output.join('\n')
    : `No matches found for: ${pattern}`;
  return { content: [{ type: 'text' as const, text }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
