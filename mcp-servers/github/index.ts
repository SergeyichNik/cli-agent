import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const GITHUB_TOKEN = process.env.GITHUB_TOKEN ?? '';
const BASE_URL = 'https://api.github.com';

async function ghFetch(urlPath: string, options: RequestInit = {}): Promise<Response> {
  const headers: Record<string, string> = {
    'Accept': 'application/vnd.github+json',
    'X-GitHub-Api-Version': '2022-11-28',
    ...(options.headers as Record<string, string> ?? {}),
  };
  if (GITHUB_TOKEN) headers['Authorization'] = `Bearer ${GITHUB_TOKEN}`;
  return fetch(`${BASE_URL}${urlPath}`, { ...options, headers });
}

async function checkError(res: Response): Promise<string | null> {
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    return `GitHub API error ${res.status}: ${body}`;
  }
  return null;
}

const server = new McpServer({ name: 'github', version: '1.0.0' });

server.registerTool('github_get_pr_diff', {
  description: 'Get the unified diff of a GitHub pull request.',
  inputSchema: {
    owner: z.string().describe('Repository owner (user or org)'),
    repo: z.string().describe('Repository name'),
    pr_number: z.number().describe('Pull request number'),
  },
}, async ({ owner, repo, pr_number }) => {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${pr_number}`, {
    headers: { 'Accept': 'application/vnd.github.diff' },
  });
  const err = await checkError(res);
  if (err) return { content: [{ type: 'text' as const, text: err }] };
  const diff = await res.text();
  return { content: [{ type: 'text' as const, text: diff || 'Empty diff.' }] };
});

server.registerTool('github_get_pr_files', {
  description: 'Get the list of files changed in a GitHub pull request with patch info.',
  inputSchema: {
    owner: z.string().describe('Repository owner (user or org)'),
    repo: z.string().describe('Repository name'),
    pr_number: z.number().describe('Pull request number'),
  },
}, async ({ owner, repo, pr_number }) => {
  const res = await ghFetch(`/repos/${owner}/${repo}/pulls/${pr_number}/files`);
  const err = await checkError(res);
  if (err) return { content: [{ type: 'text' as const, text: err }] };
  const files = await res.json() as Array<{
    filename: string;
    status: string;
    additions: number;
    deletions: number;
    patch?: string;
  }>;
  const lines = files.map(f =>
    `${f.status.padEnd(8)} +${f.additions}/-${f.deletions}  ${f.filename}${f.patch ? `\n${f.patch}` : ''}`,
  );
  return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
});

server.registerTool('github_post_pr_comment', {
  description: 'Post a review comment on a GitHub pull request.',
  inputSchema: {
    owner: z.string().describe('Repository owner (user or org)'),
    repo: z.string().describe('Repository name'),
    pr_number: z.number().describe('Pull request number'),
    body: z.string().describe('Comment body in Markdown'),
  },
}, async ({ owner, repo, pr_number, body }) => {
  const res = await ghFetch(`/repos/${owner}/${repo}/issues/${pr_number}/comments`, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ body }),
  });
  const err = await checkError(res);
  if (err) return { content: [{ type: 'text' as const, text: err }] };
  const result = await res.json() as { html_url: string; id: number };
  return { content: [{ type: 'text' as const, text: `Comment posted: ${result.html_url}` }] };
});

const transport = new StdioServerTransport();
await server.connect(transport);
