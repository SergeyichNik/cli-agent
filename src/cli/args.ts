import { Command } from 'commander';

export type ParsedArgs =
  | { subcommand: 'init' }
  | {
      subcommand: null;
      provider: 'deepseek' | 'lmstudio' | undefined;
      model: string | undefined;
      resume: string | undefined;
      debug: boolean;
    };

export function parseArgs(argv = process.argv): ParsedArgs {
  const program = new Command();

  // Handle init subcommand manually before commander takes over
  if (argv[2] === 'init') return { subcommand: 'init' };

  program
    .name('agent')
    .description('CLI Code Assistant Agent with long-term memory')
    .version('1.0.0')
    .addHelpCommand(false)
    .option('-p, --provider <name>', 'LLM provider: deepseek or lmstudio')
    .option('-m, --model <name>', 'Model name override')
    .option('-r, --resume <session_id>', 'Resume a previous session by ID')
    .option('-d, --debug', 'Enable debug logging', false);

  program.parse(argv);

  const opts = program.opts<{
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
    subcommand: null,
    provider: opts.provider as 'deepseek' | 'lmstudio' | undefined,
    model: opts.model,
    resume: opts.resume,
    debug: opts.debug,
  };
}
