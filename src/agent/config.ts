import { readFileSync, writeFileSync, existsSync } from 'fs';
import path from 'path';
import { z } from 'zod';

export const ProjectConfigSchema = z.object({
  provider: z.enum(['deepseek', 'lmstudio']).default('deepseek'),
  model: z.string().default('deepseek-chat'),
  preferredLanguage: z.string().default('English'),
  responseStyle: z.enum(['concise', 'detailed']).default('concise'),
  contextWindowTokens: z.number().default(32000),
  maxToolDepth: z.number().default(30),
  maxToolRetries: z.number().default(3),
  invariants: z.array(z.string()).default([]),
  // Only user-defined additional MCP servers. Built-in servers (files, linear) are auto-registered.
  mcpServers: z.record(z.string(), z.string()).default({}),
});

export type ProjectConfig = z.infer<typeof ProjectConfigSchema>;

export const AGENT_DIR = '.agent';
export const PROJECT_CONFIG_FILENAME = 'config.json';
export const PROJECT_DATA_DIRNAME = 'data';

export function getAgentConfigPath(projectRoot: string): string {
  return path.join(projectRoot, AGENT_DIR, PROJECT_CONFIG_FILENAME);
}

export function getAgentDataDir(projectRoot: string): string {
  return path.join(projectRoot, AGENT_DIR, PROJECT_DATA_DIRNAME);
}

export function loadProjectConfig(projectRoot: string): ProjectConfig {
  const configPath = getAgentConfigPath(projectRoot);
  const raw = JSON.parse(readFileSync(configPath, 'utf-8')) as unknown;
  return ProjectConfigSchema.parse(raw);
}

export function saveProjectConfig(projectRoot: string, config: ProjectConfig): void {
  const configPath = getAgentConfigPath(projectRoot);
  writeFileSync(configPath, JSON.stringify(config, null, 2));
}

export function isAgentProject(dir: string): boolean {
  return existsSync(getAgentConfigPath(dir));
}
