/**
 * Arrow-key select/confirm using Node's built-in readline + raw mode.
 * No external dependencies. Works at any terminal position.
 */
import readline from 'readline';

export type SelectOption<T> = { value: T; label: string; hint?: string };

function stripAnsi(s: string): string {
  return s.replace(/\x1b\[[0-9;]*m/g, '');
}

/** How many terminal rows does `prefix + text` occupy at the given column width? */
function visualRows(text: string, prefix: string, cols: number): number {
  const visible = prefix + stripAnsi(text);
  return Math.max(1, Math.ceil(visible.length / cols));
}

export async function arrowSelect<T>(
  message: string,
  options: SelectOption<T>[],
  initialIndex = 0,
  reserveAbove = 0,
  collapse = true,
  collapseLabel?: string,
): Promise<T | null> {
  return new Promise((resolve) => {
    let idx = Math.max(0, Math.min(initialIndex, options.length - 1));

    // Calculate actual terminal rows the message occupies (accounts for line wrapping)
    const cols = process.stdout.columns ?? 80;
    const msgRows = visualRows(message, '? ', cols);
    const height = options.length + msgRows; // total rows: wrapped message + option lines

    let rendered = false;

    // Reserve vertical space. reserveAbove accounts for lines already printed above
    // (e.g. a status line from bottomBar.drawStatus()) so cursor-up doesn't overshoot.
    const totalReserve = height + reserveAbove;
    process.stdout.write('\n'.repeat(totalReserve) + `\x1b[${totalReserve}A`);
    if (reserveAbove > 0) process.stdout.write(`\x1b[${reserveAbove}B`);

    function render() {
      if (rendered) process.stdout.write(`\x1b[${height}A`);
      rendered = true;

      // Message line (may wrap across multiple terminal rows)
      process.stdout.write(`\x1b[2K\r\x1b[1m? \x1b[0m\x1b[1m${message}\x1b[0m\n`);
      // Clear any extra rows the wrapped message occupies
      for (let r = 1; r < msgRows; r++) {
        process.stdout.write('\x1b[2K\r\n');
      }

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

    function collapseMenu() {
      // Move back to the very first row of the menu
      process.stdout.write(`\x1b[${height}A`);
      // Strip ANSI codes from selected label for cleaner summary
      const rawLabel = options[idx].label.replace(/\x1b\[[0-9;]*m/g, '');
      const summaryText = collapseLabel ?? message;
      // Write the single collapsed summary line
      process.stdout.write(`\x1b[2K\r\x1b[2m◇\x1b[0m ${summaryText} \x1b[2m→\x1b[0m ${rawLabel}\n`);
      // Erase all remaining rows (wrapped message rows + option rows)
      for (let i = 0; i < height - 1; i++) {
        process.stdout.write('\x1b[2K\r');
        if (i < height - 2) process.stdout.write('\n');
      }
      // Move cursor back to right after the summary line
      if (height > 2) process.stdout.write(`\x1b[${height - 2}A`);
    }

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
        if (collapse) collapseMenu();
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
  reserveAbove = 0,
): Promise<boolean | null> {
  return arrowSelect(
    message,
    [
      { value: true,  label: 'Yes' },
      { value: false, label: 'No' },
    ],
    initialValue ? 0 : 1,
    reserveAbove,
  );
}
