import { readFileSync, writeFileSync, mkdirSync, existsSync } from 'fs';
import path from 'path';
import os from 'os';
import { z } from 'zod';

const ProviderSecretsSchema = z.object({
  apiKey: z.string().optional(),
  baseUrl: z.string().optional(),
});

export const SecretsSchema = z.object({
  deepseek: ProviderSecretsSchema.optional(),
  lmstudio: ProviderSecretsSchema.optional(),
  linear: z.object({ apiKey: z.string().optional() }).optional(),
  github: z.object({ apiKey: z.string().optional() }).optional(),
});

export type Secrets = z.infer<typeof SecretsSchema>;

export const GLOBAL_SECRETS_DIR = path.join(os.homedir(), '.config', 'agent');
export const GLOBAL_SECRETS_PATH = path.join(GLOBAL_SECRETS_DIR, 'secrets.json');

export function loadSecrets(): Secrets {
  if (!existsSync(GLOBAL_SECRETS_PATH)) return {};
  try {
    const raw = JSON.parse(readFileSync(GLOBAL_SECRETS_PATH, 'utf-8')) as unknown;
    return SecretsSchema.parse(raw);
  } catch {
    return {};
  }
}

export function saveSecrets(secrets: Secrets): void {
  mkdirSync(GLOBAL_SECRETS_DIR, { recursive: true });
  writeFileSync(GLOBAL_SECRETS_PATH, JSON.stringify(secrets, null, 2), { mode: 0o600 });
}
