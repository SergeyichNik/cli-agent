import * as p from '@clack/prompts';
import { mkdirSync, existsSync, readFileSync, writeFileSync } from 'fs';
import path from 'path';
import {
  AGENT_DIR,
  PROJECT_CONFIG_FILENAME,
  PROJECT_DATA_DIRNAME,
  ProjectConfigSchema,
  getAgentConfigPath,
} from '../agent/config.js';
import { loadSecrets, saveSecrets, GLOBAL_SECRETS_PATH } from '../agent/secrets.js';

function updateGitignore(projectRoot: string): void {
  const gitignorePath = path.join(projectRoot, '.gitignore');
  const marker = '.agent/data';

  let content = '';
  if (existsSync(gitignorePath)) {
    content = readFileSync(gitignorePath, 'utf-8');
  }

  const lines = content.split('\n').map((l) => l.trim());
  if (lines.some((l) => l === marker || l === marker + '/')) {
    p.log.info('.gitignore already contains .agent/data — skipped');
    return;
  }

  const separator = content.length > 0 && !content.endsWith('\n') ? '\n' : '';
  writeFileSync(gitignorePath, `${content}${separator}\n# Agent data (sessions, LTM database)\n${marker}\n`);
  p.log.info('Added .agent/data to .gitignore');
}

export async function runInit(cwd: string): Promise<void> {
  const agentConfigPath = getAgentConfigPath(cwd);

  if (existsSync(agentConfigPath)) {
    console.log('Agent already initialized in this directory.');
    console.log(`Config: ${agentConfigPath}`);
    process.exit(0);
  }

  p.intro('Initializing agent project...');

  const provider = await p.select({
    message: 'Select LLM provider:',
    options: [
      { value: 'deepseek', label: 'DeepSeek', hint: 'requires API key' },
      { value: 'lmstudio', label: 'LM Studio', hint: 'local, no key needed' },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel('Initialization cancelled.');
    process.exit(0);
  }

  let apiKey: string | undefined;
  if (provider === 'deepseek') {
    const key = await p.password({
      message: 'DeepSeek API key:',
      validate: (v) => {
        if (!v) return 'API key is required for DeepSeek';
        if (!v.startsWith('sk-')) return 'Key should start with sk-';
      },
    });

    if (p.isCancel(key)) {
      p.cancel('Initialization cancelled.');
      process.exit(0);
    }
    apiKey = key;
  }

  const defaultModel = provider === 'deepseek' ? 'deepseek-v4-flash' : 'local-model';
  const model = await p.text({
    message: 'Model name:',
    defaultValue: defaultModel,
    placeholder: defaultModel,
  });

  if (p.isCancel(model)) {
    p.cancel('Initialization cancelled.');
    process.exit(0);
  }

  const preferredLanguage = await p.text({
    message: 'Preferred language for agent responses:',
    defaultValue: 'English',
    placeholder: 'English',
  });

  if (p.isCancel(preferredLanguage)) {
    p.cancel('Initialization cancelled.');
    process.exit(0);
  }

  const responseStyle = await p.select({
    message: 'Response style:',
    options: [
      { value: 'concise', label: 'Concise', hint: 'short and to the point' },
      { value: 'detailed', label: 'Detailed', hint: 'thorough explanations' },
    ],
  });

  if (p.isCancel(responseStyle)) {
    p.cancel('Initialization cancelled.');
    process.exit(0);
  }

  const linearKey = await p.text({
    message: 'Linear API key (optional, press Enter to skip):',
    placeholder: 'lin_api_...',
  });

  if (p.isCancel(linearKey)) {
    p.cancel('Initialization cancelled.');
    process.exit(0);
  }

  // Save secrets globally (outside project, cannot land in git)
  const existing = loadSecrets();
  if (apiKey) {
    existing[provider as 'deepseek' | 'lmstudio'] = { apiKey };
  }
  if (linearKey && linearKey.trim()) {
    existing.linear = { apiKey: linearKey.trim() };
  }
  saveSecrets(existing);
  if (apiKey || (linearKey && linearKey.trim())) {
    p.log.success(`Secrets saved to ${GLOBAL_SECRETS_PATH} (mode 600)`);
  }

  // Build project config (no secrets)
  const config = ProjectConfigSchema.parse({
    provider,
    model: model || defaultModel,
    preferredLanguage: preferredLanguage || 'English',
    responseStyle,
  });

  // Write .agent/config.json
  const agentDir = path.join(cwd, AGENT_DIR);
  mkdirSync(agentDir, { recursive: true });
  writeFileSync(agentConfigPath, JSON.stringify(config, null, 2));
  p.log.success(`Created ${path.relative(cwd, agentConfigPath)}`);

  // Create .agent/data/
  const dataDir = path.join(agentDir, PROJECT_DATA_DIRNAME);
  mkdirSync(dataDir, { recursive: true });

  // Update .gitignore
  updateGitignore(cwd);

  p.outro(
    [
      'Agent initialized.',
      '',
      `  \x1b[2m.agent/config.json\x1b[0m  — safe to commit (no secrets)`,
      `  \x1b[2m.agent/data/\x1b[0m        — gitignored (sessions, memory)`,
      `  \x1b[2m${GLOBAL_SECRETS_PATH}\x1b[0m  — secrets (global, never in git)`,
      '',
      "Run \x1b[1magent\x1b[0m to start.",
    ].join('\n'),
  );
}
