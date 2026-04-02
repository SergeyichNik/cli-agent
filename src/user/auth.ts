import * as p from '@clack/prompts';
import { saveConfig, type UserConfig } from './profile.js';

export async function runFirstRunWizard(userName: string): Promise<UserConfig> {
  p.intro(`Welcome, ${userName}! Let's configure your CLI agent.`);

  const preferredLanguage = await p.text({
    message: 'Preferred response language?',
    placeholder: 'English',
    defaultValue: 'English',
  });

  if (p.isCancel(preferredLanguage)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  const responseStyle = await p.select({
    message: 'Response style?',
    options: [
      { value: 'concise', label: 'Concise', hint: 'Short, to-the-point answers' },
      { value: 'detailed', label: 'Detailed', hint: 'Thorough explanations' },
    ],
  });

  if (p.isCancel(responseStyle)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  const provider = await p.select({
    message: 'LLM provider?',
    options: [
      { value: 'lmstudio', label: 'LM Studio (local)', hint: 'localhost:1234' },
      { value: 'deepseek', label: 'DeepSeek API', hint: 'Requires API key' },
    ],
  });

  if (p.isCancel(provider)) {
    p.cancel('Setup cancelled.');
    process.exit(0);
  }

  let apiKey: string | undefined;
  let model: string;

  if (provider === 'deepseek') {
    const key = await p.text({
      message: 'DeepSeek API key?',
      placeholder: 'sk-...',
    });
    if (p.isCancel(key)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }
    apiKey = key as string;
    model = 'deepseek-chat';
  } else {
    const modelInput = await p.text({
      message: 'LM Studio model name?',
      placeholder: 'local-model',
      defaultValue: 'local-model',
    });
    if (p.isCancel(modelInput)) {
      p.cancel('Setup cancelled.');
      process.exit(0);
    }
    model = modelInput as string;
  }

  const config: Partial<UserConfig> = {
    userName,
    preferredLanguage: preferredLanguage as string,
    responseStyle: responseStyle as 'concise' | 'detailed',
    provider: provider as 'deepseek' | 'lmstudio',
    model,
    apiKey,
  };

  saveConfig(userName, config);
  p.outro(`Configuration saved! Starting your session...`);

  return {
    userName,
    preferredLanguage: preferredLanguage as string,
    responseStyle: responseStyle as 'concise' | 'detailed',
    provider: provider as 'deepseek' | 'lmstudio',
    model,
    apiKey,
    contextWindowTokens: 4000,
    invariants: [],
    maxToolDepth: 10,
    maxToolRetries: 3,
  };
}
