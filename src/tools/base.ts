export interface ToolParameter {
  type: string;
  description?: string;
  properties?: Record<string, ToolParameter>;
  required?: string[];
  items?: ToolParameter;
  enum?: string[];
}

export interface ToolContext {
  /** Absolute path to the sandbox directory — all file/shell ops stay within it */
  sandboxDir: string;
}

export interface Tool {
  name: string;
  description: string;
  parameters: {
    type: 'object';
    properties: Record<string, ToolParameter>;
    required?: string[];
  };
  /** Whether this tool requires user confirmation before execution */
  requiresConfirmation?: boolean;
  execute(params: Record<string, unknown>, context: ToolContext): Promise<string>;
}
