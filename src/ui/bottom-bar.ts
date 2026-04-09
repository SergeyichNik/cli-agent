export interface BottomBarStats {
  inputTokens:  number;
  outputTokens: number;
  ctxUsed:      number;
  ctxMax:       number;
  taskState:    string;
  step:         number;
  total:        number;
}

export class BottomBar {
  private last: BottomBarStats | null = null;
  private isTTY = process.stdout.isTTY ?? false;

  update(stats: BottomBarStats): void {
    this.last = stats;
  }

  patchTaskState(state: string): void {
    if (this.last) this.last = { ...this.last, taskState: state };
  }

  /** Draw status line + separator + newline. Readline's "> " lands on line 3. */
  draw(): void {
    if (!this.last || !this.isTTY) return;
    const width = process.stdout.columns ?? 60;
    process.stdout.write('\n');
    process.stdout.write(this.statusLine(this.last) + '\n');
    process.stdout.write('\x1b[2m' + '─'.repeat(width) + '\x1b[0m\n');
  }

  /** Draw status line only. arrowSelect menu renders below it. */
  drawStatus(): void {
    if (!this.last || !this.isTTY) return;
    process.stdout.write(this.statusLine(this.last) + '\n');
  }

  private statusLine(s: BottomBarStats): string {
    const pct = s.ctxMax > 0 ? Math.min(100, Math.round((s.ctxUsed / s.ctxMax) * 100)) : 0;
    const ctxColor = pct >= 90 ? '\x1b[31m' : pct >= 70 ? '\x1b[33m' : '\x1b[32m';
    const stateColor =
      s.taskState === 'execution'  ? '\x1b[33m' :
      s.taskState === 'validation' ? '\x1b[36m' :
      s.taskState === 'planning'   ? '\x1b[34m' :
      s.taskState === 'done'       ? '\x1b[32m' : '\x1b[0m';

    const parts = [
      `\x1b[2min:\x1b[0m ${s.inputTokens.toLocaleString()}`,
      `\x1b[2mout:\x1b[0m ${s.outputTokens.toLocaleString()}`,
      `${ctxColor}ctx: ${pct}%\x1b[0m`,
      s.taskState ? `\x1b[2m[\x1b[0m${stateColor}${s.taskState}\x1b[0m\x1b[2m]\x1b[0m` : '',
      s.total > 0 ? `\x1b[2mStep\x1b[0m ${s.step}/${s.total}` : '',
    ].filter(Boolean).join('  ');

    return ` ${parts}`;
  }
}
