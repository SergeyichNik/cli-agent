import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import type { Tool } from '../tools/base.js';
import type { UserConfig } from '../user/profile.js';

/** MCP tool names that require user confirmation before execution */
const DESTRUCTIVE_TOOLS = new Set([
  'write_file', 'delete_file', 'move_file',
  'git_add', 'git_commit', 'git_checkout', 'git_init',
  'reindex',
]);

export class McpClient {
  private clients = new Map<string, Client>();

  /**
   * Spawn all MCP servers from config, list their tools, and return wrapped Tool objects
   * ready to register in the ToolRegistry.
   */
  async initialize(config: UserConfig, sandboxDir: string): Promise<Tool[]> {
    const mcpServers = config.mcpServers ?? {};
    const allTools: Tool[] = [];

    for (const [serverName, command] of Object.entries(mcpServers)) {
      const [cmd, ...cmdArgs] = command.split(' ');

      // Build env: start from a clean set of safe vars + explicitly pass SANDBOX_DIR
      const env: Record<string, string> = {};
      for (const [k, v] of Object.entries(process.env)) {
        if (v !== undefined) env[k] = v;
      }
      env.SANDBOX_DIR = sandboxDir;

      const transport = new StdioClientTransport({ command: cmd, args: cmdArgs, env });
      const client = new Client({ name: 'cli-agent', version: '1.0.0' });

      try {
        await client.connect(transport);
      } catch (err) {
        const msg = err instanceof Error ? err.message : String(err);
        process.stderr.write(`[MCP] Failed to start server "${serverName}": ${msg}\n`);
        continue;
      }

      this.clients.set(serverName, client);

      const { tools: serverTools } = await client.listTools();

      for (const serverTool of serverTools) {
        const toolName = `${serverName}__${serverTool.name}`;
        const capturedClient = client;
        const capturedOriginalName = serverTool.name;

        allTools.push({
          name: toolName,
          description: serverTool.description ?? '',
          parameters: serverTool.inputSchema as Tool['parameters'],
          requiresConfirmation: DESTRUCTIVE_TOOLS.has(capturedOriginalName),
          async execute(params) {
            const result = await capturedClient.callTool({
              name: capturedOriginalName,
              arguments: params,
            });
            const content = result.content as Array<{ type: string; text?: string }>;
            const textParts = content
              .filter((c) => c.type === 'text' && typeof c.text === 'string')
              .map((c) => c.text as string);
            return textParts.join('\n') || JSON.stringify(content);
          },
        });
      }
    }

    return allTools;
  }

  async shutdown(): Promise<void> {
    for (const client of this.clients.values()) {
      await client.close();
    }
    this.clients.clear();
  }
}
