import type { ChatCompletionTool } from 'openai/resources/chat/completions.js';
import type { Tool, ToolContext } from './base.js';

export class ToolRegistry {
  private tools = new Map<string, Tool>();
  sandboxDir: string = process.cwd();

  register(tool: Tool): void {
    this.tools.set(tool.name, tool);
  }

  get(name: string): Tool | undefined {
    return this.tools.get(name);
  }

  context(): ToolContext {
    return { sandboxDir: this.sandboxDir };
  }

  listForLLM(): ChatCompletionTool[] {
    return [...this.tools.values()].map((t) => ({
      type: 'function',
      function: {
        name: t.name,
        description: t.description,
        parameters: t.parameters,
      },
    }));
  }

  isDestructive(name: string): boolean {
    return this.tools.get(name)?.requiresConfirmation ?? false;
  }
}
