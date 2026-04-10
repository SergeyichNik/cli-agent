import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { execFile } from 'child_process';
import { promisify } from 'util';

const execFileAsync = promisify(execFile);

const repoDir = process.env.SANDBOX_DIR
  ? String(process.env.SANDBOX_DIR)
  : process.cwd();

async function git(args: string[]): Promise<string> {
  const { stdout, stderr } = await execFileAsync('git', args, {
    cwd: repoDir,
    maxBuffer: 4 * 1024 * 1024, // 4 MB
  });
  return (stdout + stderr).trim();
}

const server = new McpServer({ name: 'git', version: '1.0.0' });

server.registerTool('git_is_repo', {
  description: 'Check whether the project directory is a git repository.',
  inputSchema: {},
}, async () => {
  try {
    await git(['rev-parse', '--git-dir']);
    const branch = await git(['branch', '--show-current']);
    return { content: [{ type: 'text' as const, text: `Yes, git repository. Current branch: ${branch || '(detached HEAD)'}` }] };
  } catch {
    return { content: [{ type: 'text' as const, text: 'Not a git repository.' }] };
  }
});

server.registerTool('git_init', {
  description: 'Initialize a new git repository in the project directory.',
  inputSchema: {
    initialBranch: z.string().optional().describe('Name for the initial branch (default: main)'),
  },
}, async ({ initialBranch = 'main' }) => {
  try {
    await git(['rev-parse', '--git-dir']);
    return { content: [{ type: 'text' as const, text: 'Already a git repository — nothing to do.' }] };
  } catch {
    // Not a repo yet, proceed with init
  }
  const output = await git(['init', `-b`, initialBranch]);
  return { content: [{ type: 'text' as const, text: output }] };
});

server.registerTool('git_status', {
  description: 'Show the working tree status (staged, unstaged, untracked files).',
  inputSchema: {},
}, async () => {
  const output = await git(['status', '--short', '--branch']);
  return { content: [{ type: 'text' as const, text: output || 'Nothing to show.' }] };
});

server.registerTool('git_diff', {
  description: 'Show changes in the working tree. Optionally pass a file path to diff a specific file.',
  inputSchema: {
    path: z.string().optional().describe('File path to diff (optional, diffs everything if omitted)'),
    staged: z.boolean().optional().describe('If true, show staged (cached) changes instead of unstaged'),
  },
}, async ({ path: filePath, staged }) => {
  const args = ['diff'];
  if (staged) args.push('--staged');
  if (filePath) args.push('--', filePath);
  const output = await git(args);
  return { content: [{ type: 'text' as const, text: output || 'No changes.' }] };
});

server.registerTool('git_log', {
  description: 'Show recent commit history.',
  inputSchema: {
    limit: z.number().optional().describe('Number of commits to show (default: 20)'),
    file: z.string().optional().describe('Show only commits that touched this file'),
  },
}, async ({ limit = 20, file }) => {
  const args = ['log', `--max-count=${limit}`, '--oneline', '--decorate'];
  if (file) args.push('--', file);
  const output = await git(args);
  return { content: [{ type: 'text' as const, text: output || 'No commits yet.' }] };
});

server.registerTool('git_add', {
  description: 'Stage files for the next commit.',
  inputSchema: {
    paths: z.array(z.string()).describe('List of file paths to stage. Use ["."] to stage everything.'),
  },
}, async ({ paths }) => {
  const output = await git(['add', '--', ...paths]);
  const status = await git(['status', '--short']);
  return {
    content: [{
      type: 'text' as const,
      text: `Staged: ${paths.join(', ')}\n\n${status}`,
    }],
  };
});

server.registerTool('git_commit', {
  description: 'Create a commit with the staged changes.',
  inputSchema: {
    message: z.string().describe('Commit message'),
  },
}, async ({ message }) => {
  const output = await git(['commit', '-m', message]);
  return { content: [{ type: 'text' as const, text: output }] };
});

server.registerTool('git_branch', {
  description: 'List branches or create a new branch.',
  inputSchema: {
    name: z.string().optional().describe('New branch name to create (omit to just list branches)'),
  },
}, async ({ name }) => {
  if (name) {
    const output = await git(['branch', name]);
    return { content: [{ type: 'text' as const, text: output || `Branch created: ${name}` }] };
  }
  const output = await git(['branch', '--list', '--all']);
  return { content: [{ type: 'text' as const, text: output || 'No branches.' }] };
});

server.registerTool('git_checkout', {
  description: 'Switch to a branch or create and switch to a new branch.',
  inputSchema: {
    branch: z.string().describe('Branch name to switch to'),
    create: z.boolean().optional().describe('If true, create the branch before switching (-b)'),
  },
}, async ({ branch, create }) => {
  const args = ['checkout'];
  if (create) args.push('-b');
  args.push(branch);
  const output = await git(args);
  return { content: [{ type: 'text' as const, text: output || `Switched to ${branch}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
