/**
 * Arrow-key select/confirm using Node's built-in readline + raw mode.
 * No external dependencies. Works at any terminal position.
 */
import readline from 'readline';

export type SelectOption<T> = { value: T; label: string; hint?: string };

export async function arrowSelect<T>(
  message: string,
  options: SelectOption<T>[],
  initialIndex = 0,
): Promise<T | null> {
  return new Promise((resolve) => {
    let idx = Math.max(0, Math.min(initialIndex, options.length - 1));
    const height = options.length + 1; // message line + option lines
    let rendered = false;

    // Reserve vertical space so the menu always has room below the cursor.
    process.stdout.write('\n'.repeat(height) + `\x1b[${height}A`);

    function render() {
      if (rendered) process.stdout.write(`\x1b[${height}A`);
      rendered = true;

      // Message line
      process.stdout.write(`\x1b[2K\r\x1b[1m? \x1b[0m\x1b[1m${message}\x1b[0m\n`);

      // Option lines
      for (let i = 0; i < options.length; i++) {
        const opt = options[i];
        const sel = i === idx;
        const pointer = sel ? '\x1b[36m❯\x1b[0m' : ' ';
        const label = sel ? `\x1b[36m${opt.label}\x1b[0m` : opt.label;
        const hint = opt.hint ? `  \x1b[2m${opt.hint}\x1b[0m` : '';
        process.stdout.write(`\x1b[2K\r  ${pointer} ${label}${hint}\n`);
      }
    }

    // Enable keypress events (safe to call multiple times)
    readline.emitKeypressEvents(process.stdin);
    const stdin = process.stdin as NodeJS.ReadStream;
    const wasRaw = stdin.isRaw ?? false;
    // rl.pause() pauses stdin — we must resume it so keypress events arrive,
    // then restore the paused state afterwards.
    const wasPaused = stdin.isPaused();
    stdin.setRawMode(true);
    if (wasPaused) stdin.resume();

    render();

    function cleanup() {
      process.stdin.removeListener('keypress', onKeypress);
      try { stdin.setRawMode(wasRaw); } catch { /* ignore */ }
      if (wasPaused) stdin.pause();
    }

    function onKeypress(_: unknown, key: { name?: string; ctrl?: boolean }) {
      if (!key) return;

      if (key.name === 'up') {
        idx = (idx - 1 + options.length) % options.length;
        render();
      } else if (key.name === 'down') {
        idx = (idx + 1) % options.length;
        render();
      } else if (key.name === 'return') {
        cleanup();
        resolve(options[idx].value);
      } else if (key.name === 'escape' || (key.ctrl && key.name === 'c')) {
        cleanup();
        if (key.ctrl && key.name === 'c') process.exit(0);
        resolve(null);
      }
    }

    process.stdin.on('keypress', onKeypress);
  });
}

export async function arrowConfirm(
  message: string,
  initialValue = true,
): Promise<boolean | null> {
  return arrowSelect(
    message,
    [
      { value: true,  label: 'Yes' },
      { value: false, label: 'No' },
    ],
    initialValue ? 0 : 1,
  );
}
