import { readFileSync, writeFileSync, existsSync, mkdirSync } from 'fs';
import path from 'path';
import os from 'os';
import { z } from 'zod';

export const UserConfigSchema = z.object({
  userName: z.string(),
  preferredLanguage: z.string().default('English'),
  responseStyle: z.enum(['concise', 'detailed']).default('concise'),
  provider: z.enum(['deepseek', 'lmstudio']).default('lmstudio'),
  model: z.string().default('local-model'),
  apiKey: z.string().optional(),
  contextWindowTokens: z.number().default(32000),
  invariants: z.array(z.string()).default([]),
  maxToolDepth: z.number().default(10),
  maxToolRetries: z.number().default(3),
  mcpServers: z.record(z.string(), z.string()).default({
    files: 'tsx mcp-servers/files/index.ts',
  }),
});

export type UserConfig = z.infer<typeof UserConfigSchema>;

const GLOBAL_CONFIG_PATH = path.join(os.homedir(), '.config', 'cli-agent', 'config.json');
const DATA_DIR = path.join(process.cwd(), 'data', 'users');

export function getUserDataDir(userName: string): string {
  return path.join(DATA_DIR, userName);
}

export function getUserConfigPath(userName: string): string {
  return path.join(getUserDataDir(userName), 'config.json');
}

export function getUserLtmPath(userName: string): string {
  return path.join(getUserDataDir(userName), 'ltm.db');
}

export function getUserSessionsDir(userName: string): string {
  return path.join(getUserDataDir(userName), 'sessions');
}

function readJsonSafe(filePath: string): Record<string, unknown> {
  if (!existsSync(filePath)) return {};
  try {
    return JSON.parse(readFileSync(filePath, 'utf-8')) as Record<string, unknown>;
  } catch {
    return {};
  }
}

function deepMerge(
  base: Record<string, unknown>,
  override: Record<string, unknown>,
): Record<string, unknown> {
  const result = { ...base };
  for (const [k, v] of Object.entries(override)) {
    if (v !== null && typeof v === 'object' && !Array.isArray(v)) {
      result[k] = deepMerge(
        (base[k] as Record<string, unknown>) ?? {},
        v as Record<string, unknown>,
      );
    } else {
      result[k] = v;
    }
  }
  return result;
}

export function loadConfig(userName: string): UserConfig {
  const globalRaw = readJsonSafe(GLOBAL_CONFIG_PATH);
  const userRaw = readJsonSafe(getUserConfigPath(userName));
  const merged = deepMerge(globalRaw, { ...userRaw, userName });
  const parsed = UserConfigSchema.parse(merged);

  // Persist any new fields (filled by zod defaults) back to the user config file
  const newKeys = (Object.keys(parsed) as (keyof UserConfig)[]).filter((k) => !(k in userRaw));
  if (newKeys.length > 0) {
    const patch = Object.fromEntries(newKeys.map((k) => [k, parsed[k]]));
    saveConfig(userName, patch);
  }

  return parsed;
}

export function saveConfig(userName: string, config: Partial<UserConfig>): void {
  const dir = getUserDataDir(userName);
  mkdirSync(dir, { recursive: true });
  const existing = readJsonSafe(getUserConfigPath(userName));
  const updated = { ...existing, ...config };
  writeFileSync(getUserConfigPath(userName), JSON.stringify(updated, null, 2));
}

export function userExists(userName: string): boolean {
  return existsSync(getUserConfigPath(userName));
}
