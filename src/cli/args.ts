import { Command } from 'commander';
import os from 'os';

export interface CliArgs {
  user: string;
  provider: 'deepseek' | 'lmstudio' | undefined;
  model: string | undefined;
  resume: string | undefined;
  debug: boolean;
}

export function parseArgs(argv = process.argv): CliArgs {
  const program = new Command();

  program
    .name('cli-agent')
    .description('CLI Code Assistant Agent with long-term memory')
    .version('1.0.0')
    .option('-u, --user <name>', 'User profile name', os.userInfo().username)
    .option('-p, --provider <name>', 'LLM provider: deepseek or lmstudio')
    .option('-m, --model <name>', 'Model name override')
    .option('-r, --resume <session_id>', 'Resume a previous session by ID')
    .option('-d, --debug', 'Enable debug logging', false);

  program.parse(argv);

  const opts = program.opts<{
    user: string;
    provider?: string;
    model?: string;
    resume?: string;
    debug: boolean;
  }>();

  if (opts.provider && !['deepseek', 'lmstudio'].includes(opts.provider)) {
    console.error(`Invalid provider: ${opts.provider}. Use 'deepseek' or 'lmstudio'.`);
    process.exit(1);
  }

  return {
    user: opts.user,
    provider: opts.provider as 'deepseek' | 'lmstudio' | undefined,
    model: opts.model,
    resume: opts.resume,
    debug: opts.debug,
  };
}
