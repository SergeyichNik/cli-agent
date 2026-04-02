import * as p from '@clack/prompts';
import { saveConfig, type UserConfig } from './profile.js';

export async function runFirstRunWizard(userName: string): Promise<Partial<UserConfig>> {
  p.intro(`First run for "${userName}" — a few quick questions.`);
  p.note('Provider, model and API key are read from .env', 'LLM config');

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

  const partial: Partial<UserConfig> = {
    userName,
    preferredLanguage: preferredLanguage as string,
    responseStyle: responseStyle as 'concise' | 'detailed',
  };

  saveConfig(userName, partial);
  p.outro('Profile saved.');

  return partial;
}
