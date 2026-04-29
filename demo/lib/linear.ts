/**
 * Shared Linear API helpers for Day 33 multi-agent demo.
 */

const LINEAR_API_URL = 'https://api.linear.app/graphql';

export type CommentAuthorType = 'support' | 'user' | 'resolved' | 'unknown';

export interface Issue {
  id: string;
  title: string;
  description: string | null;
  priority: number;
  state: { id: string; name: string; type: string };
  assignee: { name: string } | null;
  team: { id: string; name: string };
  url: string;
}

export interface WorkflowState {
  id: string;
  name: string;
  type: string;
}

export interface Comment {
  id: string;
  body: string;
  createdAt: string;
  user: { id: string; name: string } | null;
}

async function linearQuery<T>(apiKey: string, query: string, variables: Record<string, unknown> = {}): Promise<T> {
  const res = await fetch(LINEAR_API_URL, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json', Authorization: apiKey },
    body: JSON.stringify({ query, variables }),
  });
  if (!res.ok) throw new Error(`Linear HTTP ${res.status}: ${res.statusText}`);
  const json = (await res.json()) as { data?: T; errors?: Array<{ message: string }> };
  if (json.errors?.length) throw new Error(json.errors.map((e) => e.message).join('; '));
  if (!json.data) throw new Error('Linear returned no data');
  return json.data;
}

export async function getViewer(apiKey: string): Promise<{ id: string; name: string }> {
  const data = await linearQuery<{ viewer: { id: string; name: string } }>(
    apiKey, `query { viewer { id name } }`,
  );
  return data.viewer;
}

export async function getFirstTeam(apiKey: string): Promise<{ id: string; name: string }> {
  const data = await linearQuery<{ teams: { nodes: Array<{ id: string; name: string }> } }>(
    apiKey, `query { teams { nodes { id name } } }`,
  );
  const [team] = data.teams.nodes;
  if (!team) throw new Error('No Linear teams found');
  return team;
}

export async function getWorkflowStates(apiKey: string, teamId: string): Promise<WorkflowState[]> {
  const data = await linearQuery<{ team: { states: { nodes: WorkflowState[] } } }>(
    apiKey,
    `query TeamStates($teamId: String!) {
      team(id: $teamId) {
        states { nodes { id name type } }
      }
    }`,
    { teamId },
  );
  return data.team.states.nodes;
}

export async function listIssues(
  apiKey: string,
  opts: { teamId?: string; limit?: number } = {},
): Promise<Array<{ id: string; title: string; state: { id: string; name: string; type: string }; url: string }>> {
  const filter: Record<string, unknown> = {};
  if (opts.teamId) filter.team = { id: { eq: opts.teamId } };

  const data = await linearQuery<{
    issues: { nodes: Array<{ id: string; title: string; state: { id: string; name: string; type: string }; url: string }> };
  }>(
    apiKey,
    `query ListIssues($filter: IssueFilter, $first: Int) {
      issues(filter: $filter, first: $first) {
        nodes { id title url state { id name type } }
      }
    }`,
    { filter: Object.keys(filter).length ? filter : undefined, first: opts.limit ?? 20 },
  );
  return data.issues.nodes;
}

export async function getIssue(apiKey: string, issueId: string): Promise<Issue> {
  const data = await linearQuery<{ issue: Issue }>(
    apiKey,
    `query GetIssue($id: String!) {
      issue(id: $id) {
        id title description priority url
        state { id name type }
        assignee { name }
        team { id name }
      }
    }`,
    { id: issueId },
  );
  return data.issue;
}

export async function createIssue(
  apiKey: string,
  input: { title: string; teamId: string; description: string; priority?: number },
): Promise<{ id: string; title: string; url: string; state: { name: string } }> {
  const data = await linearQuery<{
    issueCreate: { issue: { id: string; title: string; url: string; state: { name: string } } };
  }>(
    apiKey,
    `mutation CreateIssue($input: IssueCreateInput!) {
      issueCreate(input: $input) { issue { id title url state { name } } }
    }`,
    { input },
  );
  return data.issueCreate.issue;
}

export async function updateIssue(
  apiKey: string,
  issueId: string,
  update: { description?: string; stateId?: string },
): Promise<{ id: string; title: string; url: string }> {
  const data = await linearQuery<{
    issueUpdate: { issue: { id: string; title: string; url: string } };
  }>(
    apiKey,
    `mutation UpdateIssue($id: String!, $input: IssueUpdateInput!) {
      issueUpdate(id: $id, input: $input) { issue { id title url } }
    }`,
    { id: issueId, input: update },
  );
  return data.issueUpdate.issue;
}

export async function listComments(apiKey: string, issueId: string): Promise<Comment[]> {
  const data = await linearQuery<{
    issue: { comments: { nodes: Comment[] } };
  }>(
    apiKey,
    `query IssueComments($id: String!) {
      issue(id: $id) {
        comments(orderBy: createdAt) {
          nodes { id body createdAt user { id name } }
        }
      }
    }`,
    { id: issueId },
  );
  return data.issue.comments.nodes.sort(
    (a, b) => new Date(a.createdAt).getTime() - new Date(b.createdAt).getTime(),
  );
}

export async function createComment(apiKey: string, issueId: string, body: string): Promise<{ id: string }> {
  const data = await linearQuery<{
    commentCreate: { comment: { id: string } };
  }>(
    apiKey,
    `mutation CreateComment($input: CommentCreateInput!) {
      commentCreate(input: $input) { comment { id } }
    }`,
    { input: { issueId, body } },
  );
  return data.commentCreate.comment;
}

// RESOLVED marker — still needed as a signal in the comment body
export const RESOLVED_MARKER = '<!-- resolved -->';

export function getCommentAuthor(
  comment: Comment,
  supportUserId: string,
): CommentAuthorType {
  if (!comment.user) return 'unknown';
  if (comment.body.includes(RESOLVED_MARKER)) return 'resolved';
  return comment.user.id === supportUserId ? 'support' : 'user';
}

export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
