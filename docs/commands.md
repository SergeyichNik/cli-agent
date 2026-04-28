# Commands

## CLI Flags

```bash
agent                          # start agent session (default provider from config)
agent init                     # initialize agent in current folder
agent --provider deepseek      # use DeepSeek LLM
agent --provider lmstudio      # use local LM Studio
agent --model <name>           # override model name
agent --resume <session_id>    # resume a previous session
agent --debug                  # enable debug logging
```

## Session Slash Commands

These commands are available during an active agent session:

| Command | Description |
|---------|-------------|
| `/help` | Show this command list |
| `/help <question>` | Ask the agent a question about the project (uses RAG over docs/) |
| `/state` | Show current task state and plan progress |
| `/facts` | Show session facts stored in long-term memory |
| `/invariants` | Show all invariants (global from config + session-local) |
| `/invariant <rule>` | Add a session-local invariant rule (persists for this session) |
| `/mcp` | List all MCP tools from connected servers |
| `/mcp <server>` | List tools from a specific MCP server (e.g. `/mcp git`) |
| `/exit` or `/quit` | Exit the agent |

## Examples

```bash
# Ask about project structure
/help how do I add a new MCP server?

# Ask about configuration
/help where are API keys stored?

# Check what git tools are available
/mcp git

# Add a rule for this session
/invariant always use TypeScript strict mode
```
