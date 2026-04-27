# Architecture

## Overview

CLI Agent is a TypeScript project compiled to `dist/` and installed globally via `npm link`. It runs as an interactive terminal agent that uses MCP (Model Context Protocol) servers for tool execution.

## Entry Points

- `src/cli/index.ts` → `dist/cli/index.js` — main binary, session loop, slash command handling
- `src/cli/init.ts` — `agent init` command, creates `.agent/` directory structure
- `src/cli/args.ts` — CLI argument parsing
- `src/core/agent.ts` — agent loop, state machine, tool execution
- `src/context/optimizer.ts` — system prompt construction, context injection

## Initialization Flow

```
agent init
  → creates .agent/config.json    (project config, safe to commit)
  → creates .agent/data/          (sessions + LTM database, gitignored)
  → writes to .gitignore

Secrets (API keys)
  → ~/.config/agent/secrets.json  (mode 600, never in git)
```

## Sandbox Boundary

The folder where `agent init` was run is the sandbox root. The agent cannot access files outside it. All MCP servers receive `SANDBOX_DIR` as an environment variable and enforce this boundary.

## State Machine

Tasks follow a strict state machine:

```
planning → execution → validation → done
```

- **planning**: agent creates a plan, emits CONFIRM to proceed
- **execution**: agent executes steps using tools
- **validation**: agent verifies the result
- **done**: task complete

## Config / Secrets Split

| File | Location | Contains | In git? |
|------|----------|----------|---------|
| `.agent/config.json` | project root | provider, model, mcpServers, invariants | ✅ safe |
| `~/.config/agent/secrets.json` | home dir | API keys | ❌ never |

## MCP Servers

Built-in servers are auto-registered on startup:

| Server | Path | Purpose |
|--------|------|---------|
| `files` | `mcp-servers/files/` | File CRUD within sandbox |
| `git` | `mcp-servers/git/` | Git operations |
| `search` | `mcp-servers/search/` | Semantic search / RAG |
| `linear` | `mcp-servers/linear/` | Linear integration (needs API key) |

## RAG System

The `search` MCP server provides full RAG capabilities:

- **Vector store**: SQLite at `.agent/data/search.db`
- **Embeddings**: Ollama (`nomic-embed-text`) or OpenAI-compatible
- **Chunking**: fixed-size (512 tokens, 50 overlap) or structural (by headings / exports)
- **Search**: cosine similarity, configurable topK and min score

Tools: `search__index_documents`, `search__search`, `search__index_status`, `search__reindex`
