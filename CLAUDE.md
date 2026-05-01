# CLI Agent — Project Context

## What this is
A personal CLI agent (like Claude Code) that can be initialized in any folder and called as `agent`. Built with TypeScript, compiled to `dist/`, installed globally via `npm link`.

## Key commands
```bash
npm run build   # clean dist/ + compile src/ + mcp-servers/
npm run dev     # run without build (via tsx, for development)
agent init      # initialize agent in current folder
agent           # start agent session
```

## Architecture

### Initialization flow
- `agent init` → creates `.agent/config.json` (no secrets) + `.agent/data/` + updates `.gitignore`
- Secrets (API keys) → `~/.config/agent/secrets.json` (mode 600, outside project, never in git)
- Project config → `.agent/config.json` (safe to commit)
- Sessions + LTM database → `.agent/data/` (gitignored)

### Sandbox boundary
The folder where `agent init` was run = sandbox root. Agent cannot access files outside it.

### Entry points
- `src/cli/index.ts` → `dist/cli/index.js` (main binary)
- `src/cli/init.ts` → `agent init` command
- `src/cli/args.ts` → CLI argument parsing

### MCP servers (auto-registered, built-in)
- `mcp-servers/files/` → file CRUD within sandbox
- `mcp-servers/git/` → git operations (status, diff, log, add, commit, branch, checkout, init)
- `mcp-servers/search/` → search across project files and documentation
- `mcp-servers/github/` → GitHub API integration (PR review, issues, etc.)
- `mcp-servers/linear/` → Linear integration (only if `LINEAR_API_KEY` is set in secrets or env)

### Key config files
- `src/agent/config.ts` → ProjectConfig schema (non-sensitive project settings)
- `src/agent/secrets.ts` → Secrets schema + load/save to `~/.config/agent/secrets.json`
- `src/mcp/client.ts` → spawns MCP servers, defines DESTRUCTIVE_TOOLS (require confirmation)
- `src/user/profile.ts` → UserConfig type (still used by agent.ts, client.ts, optimizer.ts)

### Adding a new built-in MCP server
1. Create `mcp-servers/<name>/index.ts`
2. Add to `builtinMcpServers` in `src/cli/index.ts`
3. Add destructive tool names to `DESTRUCTIVE_TOOLS` in `src/mcp/client.ts`
4. `npm run build`

### Adding an external MCP server (no rebuild needed)
Add to `.agent/config.json` in the target project:
```json
{ "mcpServers": { "my-server": "node /path/to/server/index.js" } }
```

## Providers
- `deepseek` — requires API key in `~/.config/agent/secrets.json`
- `lmstudio` — local, no key needed, URL: `http://localhost:1234/v1`
