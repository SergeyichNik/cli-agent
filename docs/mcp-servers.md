# MCP Servers

MCP (Model Context Protocol) servers expose tools to the agent. Built-in servers are auto-registered on startup.

## Built-in Servers

### files

File CRUD operations within the sandbox.

Tools: `files__read`, `files__write`, `files__list`, `files__delete`, `files__move`

### git

Git operations scoped to the sandbox directory.

Tools:
- `git__git_is_repo` — check if directory is a git repo, returns **current branch**
- `git__git_status` — show working tree status
- `git__git_diff` — show changes (supports staged, specific file)
- `git__git_log` — show commit history
- `git__git_add` — stage files
- `git__git_commit` — create a commit
- `git__git_branch` — list or create branches
- `git__git_checkout` — switch branches
- `git__git_init` — initialize a new repo

### search

Semantic search / RAG over project files.

Tools:
- `search__index_documents(glob, strategy)` — index files into vector store
- `search__search(query, topK?, strategy?, source?, minScore?)` — semantic search
- `search__index_status()` — show index stats
- `search__reindex(glob?)` — re-index after changes

**Embeddings config** in `.agent/config.json`:

```json
{
  "embeddingProvider": {
    "type": "ollama",
    "model": "nomic-embed-text",
    "url": "http://localhost:11434"
  }
}
```

Or use OpenAI-compatible:

```json
{
  "embeddingProvider": {
    "type": "openai-compatible",
    "url": "https://api.openai.com/v1",
    "apiKey": "sk-..."
  }
}
```

### linear

Linear project management integration. Only active if `LINEAR_API_KEY` is set in secrets.

Tools: `linear__list_teams`, `linear__create_issue`, `linear__list_issues`, `linear__update_issue`

## Adding an External MCP Server

No rebuild needed. Add to `.agent/config.json`:

```json
{
  "mcpServers": {
    "my-server": "node /absolute/path/to/server/index.js"
  }
}
```

The agent will auto-register it on next startup. List its tools with `/mcp my-server`.

## Adding a Built-in MCP Server (Добавление встроенного MCP сервера)

To add a new built-in MCP server that is auto-registered on startup, follow these steps. Requires a rebuild.

Чтобы добавить новый встроенный MCP сервер в проект, нужно выполнить 4 шага.

**Step 1.** Create the server file:
```
mcp-servers/<name>/index.ts
```

**Step 2.** Register the server in `src/cli/index.ts` — add to the `builtinMcpServers` object:
```typescript
builtinMcpServers: {
  files: `node ${path.join(packageRoot, 'dist/mcp-servers/files/index.js')}`,
  git:   `node ${path.join(packageRoot, 'dist/mcp-servers/git/index.js')}`,
  // add your server here:
  myserver: `node ${path.join(packageRoot, 'dist/mcp-servers/myserver/index.js')}`,
}
```

**Step 3.** If your server has destructive tools (delete, write, etc.), add their names to `DESTRUCTIVE_TOOLS` in `src/mcp/client.ts`.

**Step 4.** Rebuild:
```bash
npm run build
```

After rebuild, the new server is available automatically in every agent session.
