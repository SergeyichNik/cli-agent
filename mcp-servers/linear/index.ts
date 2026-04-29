import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';

const LINEAR_API_URL = 'https://api.linear.app/graphql';

async function linearQuery<T>(
  query: string,
  variables: Record<string, unknown> = {},
): Promise<T> {
  const apiKey = process.env.LINEAR_API_KEY;
  if (!apiKey) throw new Error('LINEAR_API_KEY is not set');

  const res = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: apiKey,
    },
    body: JSON.stringify({ query, variables }),
  });

  if (!res.ok) {
    throw new Error(`Linear API HTTP error: ${res.status} ${res.statusText}`);
  }

  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) {
    throw new Error(json.errors.map((e) => e.message).join('; '));
  }
  if (!json.data) throw new Error('Linear API returned no data');
  return json.data;
}

const server = new McpServer({ name: 'linear', version: '1.0.0' });

// ── list_teams ────────────────────────────────────────────────────────────────

server.registerTool(
  'list_teams',
  {
    description:
      'List all Linear teams in the workspace. Returns team IDs (UUIDs) and names. Always call this first when you need a teamId for create_issue.',
    inputSchema: {},
  },
  async () => {
    const query = `
      query ListTeams {
        teams {
          nodes {
            id
            name
            key
          }
        }
      }
    `;

    const data = await linearQuery<{
      teams: { nodes: Array<{ id: string; name: string; key: string }> };
    }>(query);

    const teams = data.teams.nodes;
    if (!teams.length) {
      return { content: [{ type: 'text' as const, text: 'No teams found.' }] };
    }

    const lines = teams.map((t) => `${t.name} (key: ${t.key})\n  teamId (UUID): ${t.id}`);
    return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
  },
);

// ── list_issues ───────────────────────────────────────────────────────────────

server.registerTool(
  'list_issues',
  {
    description:
      'List issues from Linear. Optionally filter by teamId, status name, or assigneeId.',
    inputSchema: {
      teamId: z.string().optional().describe('Linear team ID to filter by'),
      status: z.string().optional().describe('State name to filter by (e.g. "In Progress", "Todo")'),
      assigneeId: z.string().optional().describe('Assignee user ID to filter by'),
      limit: z.number().int().min(1).max(50).optional().default(20).describe('Max issues to return (default 20)'),
    },
  },
  async ({ teamId, status, assigneeId, limit }) => {
    const filter: Record<string, unknown> = {};
    if (teamId) filter.team = { id: { eq: teamId } };
    if (status) filter.state = { name: { eq: status } };
    if (assigneeId) filter.assignee = { id: { eq: assigneeId } };

    const query = `
      query ListIssues($filter: IssueFilter, $first: Int) {
        issues(filter: $filter, first: $first) {
          nodes {
            id
            title
            url
            priority
            state { name }
            assignee { name }
            team { name }
          }
        }
      }
    `;

    const data = await linearQuery<{
      issues: {
        nodes: Array<{
          id: string;
          title: string;
          url: string;
          priority: number;
          state: { name: string };
          assignee: { name: string } | null;
          team: { name: string };
        }>;
      };
    }>(query, { filter: Object.keys(filter).length ? filter : undefined, first: limit });

    const issues = data.issues.nodes;
    if (!issues.length) {
      return { content: [{ type: 'text' as const, text: 'No issues found.' }] };
    }

    const PRIORITY_LABEL: Record<number, string> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
    const lines = issues.map(
      (i) =>
        `[${i.id}] ${i.title}\n  State: ${i.state.name} | Priority: ${PRIORITY_LABEL[i.priority] ?? i.priority} | Assignee: ${i.assignee?.name ?? '—'} | Team: ${i.team.name}\n  URL: ${i.url}`,
    );

    return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
  },
);

// ── create_issue ──────────────────────────────────────────────────────────────

server.registerTool(
  'create_issue',
  {
    description: 'Create a new issue in Linear.',
    inputSchema: {
      title: z.string().describe('Issue title'),
      teamId: z.string().describe('Linear team ID to create the issue in'),
      description: z.string().optional().describe('Issue description (markdown supported)'),
      priority: z
        .number()
        .int()
        .min(0)
        .max(4)
        .optional()
        .describe('Priority: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low'),
    },
  },
  async ({ title, teamId, description, priority }) => {
    const mutation = `
      mutation CreateIssue($input: IssueCreateInput!) {
        issueCreate(input: $input) {
          success
          issue {
            id
            title
            url
            state { name }
          }
        }
      }
    `;

    const input: Record<string, unknown> = { title, teamId };
    if (description !== undefined) input.description = description;
    if (priority !== undefined) input.priority = priority;

    const data = await linearQuery<{
      issueCreate: { success: boolean; issue: { id: string; title: string; url: string; state: { name: string } } };
    }>(mutation, { input });

    const { issue } = data.issueCreate;
    return {
      content: [
        {
          type: 'text' as const,
          text: `Created: [${issue.id}] ${issue.title}\nState: ${issue.state.name}\nURL: ${issue.url}`,
        },
      ],
    };
  },
);

// ── list_workflow_states ──────────────────────────────────────────────────────

server.registerTool(
  'list_workflow_states',
  {
    description: 'List workflow states for a Linear team. Returns state IDs needed for update_issue stateId.',
    inputSchema: {
      teamId: z.string().describe('Linear team ID'),
    },
  },
  async ({ teamId }) => {
    const query = `
      query TeamStates($teamId: String!) {
        team(id: $teamId) {
          states { nodes { id name type } }
        }
      }
    `;
    const data = await linearQuery<{
      team: { states: { nodes: Array<{ id: string; name: string; type: string }> } };
    }>(query, { teamId });

    const states = data.team.states.nodes;
    if (!states.length) {
      return { content: [{ type: 'text' as const, text: 'No workflow states found.' }] };
    }

    const lines = states.map((s) => `${s.name} (type: ${s.type})\n  stateId: ${s.id}`);
    return { content: [{ type: 'text' as const, text: lines.join('\n\n') }] };
  },
);

// ── get_issue ─────────────────────────────────────────────────────────────────

server.registerTool(
  'get_issue',
  {
    description: 'Get a single Linear issue by ID. Returns full details including description.',
    inputSchema: {
      issueId: z.string().describe('Linear issue ID (e.g. "abc123")'),
    },
  },
  async ({ issueId }) => {
    const query = `
      query GetIssue($id: String!) {
        issue(id: $id) {
          id
          title
          description
          priority
          state { name }
          assignee { name }
          team { name }
          url
        }
      }
    `;

    const data = await linearQuery<{
      issue: {
        id: string;
        title: string;
        description: string | null;
        priority: number;
        state: { name: string };
        assignee: { name: string } | null;
        team: { name: string };
        url: string;
      };
    }>(query, { id: issueId });

    const i = data.issue;
    const PRIORITY_LABEL: Record<number, string> = { 0: 'No priority', 1: 'Urgent', 2: 'High', 3: 'Medium', 4: 'Low' };
    const text = [
      `[${i.id}] ${i.title}`,
      `State: ${i.state.name} | Priority: ${PRIORITY_LABEL[i.priority] ?? i.priority} | Assignee: ${i.assignee?.name ?? '—'} | Team: ${i.team.name}`,
      `URL: ${i.url}`,
      i.description ? `\nDescription:\n${i.description}` : '',
    ].filter(Boolean).join('\n');

    return { content: [{ type: 'text' as const, text }] };
  },
);

// ── update_issue ──────────────────────────────────────────────────────────────

server.registerTool(
  'update_issue',
  {
    description:
      'Update an existing Linear issue. Pass only the fields you want to change.',
    inputSchema: {
      issueId: z.string().describe('Linear issue ID (e.g. "abc123")'),
      stateId: z.string().optional().describe('New state ID (use list_workflow_states to find IDs)'),
      assigneeId: z.string().optional().describe('New assignee user ID'),
      priority: z
        .number()
        .int()
        .min(0)
        .max(4)
        .optional()
        .describe('New priority: 0=No priority, 1=Urgent, 2=High, 3=Medium, 4=Low'),
      title: z.string().optional().describe('New title'),
      description: z.string().optional().describe('New description'),
    },
  },
  async ({ issueId, stateId, assigneeId, priority, title, description }) => {
    const mutation = `
      mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
        issueUpdate(id: $id, input: $input) {
          success
          issue {
            id
            title
            url
            state { name }
            assignee { name }
          }
        }
      }
    `;

    const input: Record<string, unknown> = {};
    if (stateId !== undefined) input.stateId = stateId;
    if (assigneeId !== undefined) input.assigneeId = assigneeId;
    if (priority !== undefined) input.priority = priority;
    if (title !== undefined) input.title = title;
    if (description !== undefined) input.description = description;

    if (!Object.keys(input).length) {
      return { content: [{ type: 'text' as const, text: 'No fields to update provided.' }] };
    }

    const data = await linearQuery<{
      issueUpdate: {
        success: boolean;
        issue: { id: string; title: string; url: string; state: { name: string }; assignee: { name: string } | null };
      };
    }>(mutation, { id: issueId, input });

    const { issue } = data.issueUpdate;
    return {
      content: [
        {
          type: 'text' as const,
          text: `Updated: [${issue.id}] ${issue.title}\nState: ${issue.state.name} | Assignee: ${issue.assignee?.name ?? '—'}\nURL: ${issue.url}`,
        },
      ],
    };
  },
);

// ── list_comments ─────────────────────────────────────────────────────────────

server.registerTool(
  'list_comments',
  {
    description: 'List all comments on a Linear issue, ordered by creation time.',
    inputSchema: {
      issueId: z.string().describe('Linear issue ID'),
    },
  },
  async ({ issueId }) => {
    const query = `
      query IssueComments($id: String!) {
        issue(id: $id) {
          comments(orderBy: createdAt) {
            nodes { id body createdAt }
          }
        }
      }
    `;
    const data = await linearQuery<{
      issue: { comments: { nodes: Array<{ id: string; body: string; createdAt: string }> } };
    }>(query, { id: issueId });

    const comments = data.issue.comments.nodes;
    if (!comments.length) {
      return { content: [{ type: 'text' as const, text: 'No comments.' }] };
    }
    const lines = comments.map((c) => `[${c.id}] ${c.createdAt}\n${c.body}`);
    return { content: [{ type: 'text' as const, text: lines.join('\n\n---\n\n') }] };
  },
);

// ── create_comment ────────────────────────────────────────────────────────────

server.registerTool(
  'create_comment',
  {
    description: 'Post a comment on a Linear issue.',
    inputSchema: {
      issueId: z.string().describe('Linear issue ID'),
      body: z.string().describe('Comment body (markdown supported)'),
    },
  },
  async ({ issueId, body }) => {
    const mutation = `
      mutation CreateComment($input: CommentCreateInput!) {
        commentCreate(input: $input) {
          comment { id createdAt }
        }
      }
    `;
    const data = await linearQuery<{
      commentCreate: { comment: { id: string; createdAt: string } };
    }>(mutation, { input: { issueId, body } });

    const { comment } = data.commentCreate;
    return {
      content: [{ type: 'text' as const, text: `Comment posted: id=${comment.id} at ${comment.createdAt}` }],
    };
  },
);

const transport = new StdioServerTransport();
await server.connect(transport);
