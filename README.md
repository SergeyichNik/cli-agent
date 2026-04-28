# CLI Agent

A personal developer assistant CLI (like Claude Code) that can be initialized in any folder and called as `agent`. Built with TypeScript, uses DeepSeek or LM Studio as LLM providers.

## Quick Start

```bash
npm run build
npm link
cd /your/project
agent init
agent
```

## Documentation

- [Architecture](docs/architecture.md) — project structure, entry points, sandbox boundary
- [Commands](docs/commands.md) — CLI flags and session slash commands
- [Providers](docs/providers.md) — configuring DeepSeek and LM Studio
- [MCP Servers](docs/mcp-servers.md) — built-in servers and adding custom ones

## Key Commands

```bash
npm run build   # compile src/ + mcp-servers/ → dist/
npm run dev     # run without build via tsx (development)
agent init      # initialize agent in current folder
agent           # start agent session
agent --provider deepseek   # use DeepSeek
agent --provider lmstudio   # use local LM Studio
agent review-pr --repo owner/repo --pr 42  # AI code review of a PR
```

## AI Code Review

Automated PR review via GitHub Actions. On every pull request, the agent:
- fetches the diff and changed files from GitHub
- reads the local file contents for context
- generates a structured review (bugs / architecture / recommendations) via DeepSeek
- posts the review as a PR comment

Requires `DEEPSEEK_API_KEY` in repository secrets. `GITHUB_TOKEN` is provided automatically.
