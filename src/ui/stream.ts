import { renderMarkdown } from './renderer.js';
import type { Task, TaskState } from '../core/task-state.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class StreamRenderer {
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private streaming = false;
  private rawBuffer = '';

  // Token tracking
  private outputEstimate = 0;
  private startTime = 0;
  private lastCounterUpdate = 0;
  private isTTY = process.stdout.isTTY ?? false;

  // --- Spinner ---

  startSpinner(label = 'Thinking'): void {
    this.lastCounterUpdate = 0;
    this.spinnerInterval = setInterval(() => {
      const frame = SPINNER_FRAMES[this.spinnerFrame++ % SPINNER_FRAMES.length];
      process.stdout.write(`\r${frame} ${label}...`);
    }, 80);
  }

  stopSpinner(): void {
    if (this.spinnerInterval) {
      clearInterval(this.spinnerInterval);
      this.spinnerInterval = null;
      process.stdout.write('\r\x1b[K');
    }
  }

  // --- Live counter (overwrites current line via \r, no cursor save/restore) ---

  private writeLiveCounter(): void {
    const now = Date.now();
    if (now - this.lastCounterUpdate < 100) return; // throttle to ~10fps
    this.lastCounterUpdate = now;

    const elapsed = ((now - this.startTime) / 1000).toFixed(1);
    process.stdout.write(
      `\r\x1b[2m↓ ~${this.outputEstimate} tokens  ${elapsed}s\x1b[0m\x1b[K`,
    );
  }

  private clearCounterLine(): void {
    if (this.isTTY) process.stdout.write('\r\x1b[K');
  }

  // --- Token buffering (no live stdout write — avoids scroll-back complexity) ---

  onToken(text: string): void {
    this.stopSpinner();
    if (!this.streaming) {
      this.streaming = true;
      this.startTime = Date.now();
      this.outputEstimate = 0;
      this.lastCounterUpdate = 0;
    }
    this.rawBuffer += text;
    this.outputEstimate += Math.ceil(text.length / 4);
    if (this.isTTY) this.writeLiveCounter();
  }

  // --- Finalize: strip metadata line, render markdown once ---

  finalize(): void {
    this.stopSpinner();
    this.clearCounterLine();

    if (this.streaming && this.rawBuffer.trim()) {
      const display = this.stripMetadataLine(this.rawBuffer);
      if (display.trim()) {
        process.stdout.write('\n\x1b[32mAgent:\x1b[0m\n');
        process.stdout.write(renderMarkdown(display));
        if (!display.endsWith('\n')) process.stdout.write('\n');
      }
    }

    this.rawBuffer = '';
    this.streaming = false;
  }

  private stripMetadataLine(text: string): string {
    return text
      .split('\n')
      .filter((line) => {
        const t = line.trim();
        if (!t.startsWith('{') || !t.includes('"intent"')) return true;
        try { JSON.parse(t); return false; } catch { return true; }
      })
      .join('\n')
      .trimEnd();
  }

  showStateChange(prevState: string, nextState: string, intent: string): void {
    process.stdout.write(
      `\x1b[2m◈ ${intent}  ${prevState} → ${nextState}\x1b[0m\n`,
    );
  }

  reset(): void {
    this.stopSpinner();
    this.clearCounterLine();
    this.rawBuffer = '';
    this.streaming = false;
    this.outputEstimate = 0;
  }

  // --- Tool output ---

  showToolCall(toolName: string, args: string): void {
    this.stopSpinner();
    this.clearCounterLine();
    let prettyArgs = args;
    try {
      prettyArgs = JSON.stringify(JSON.parse(args), null, 2);
    } catch { /* use raw */ }
    const displayName = this.formatToolName(toolName);
    process.stdout.write(`\n\x1b[36m⚙ ${displayName}\x1b[0m\n\x1b[2m${prettyArgs}\x1b[0m\n`);
  }

  private formatToolName(name: string): string {
    const match = name.match(/^(\w+)__(.+)$/);
    if (match) return `[MCP: ${match[1]}] ${match[2]}`;
    return name;
  }

  showToolResult(result: string, truncate = 500): void {
    const display = result.length > truncate ? result.slice(0, truncate) + '…' : result;
    process.stdout.write(`\x1b[2m→ ${display}\x1b[0m\n`);
  }

  showError(msg: string): void {
    this.clearCounterLine();
    process.stdout.write(`\x1b[31m✗ ${msg}\x1b[0m\n`);
  }

  showInfo(msg: string): void {
    process.stdout.write(`\x1b[33m${msg}\x1b[0m\n`);
  }

  showTaskProgress(task: Task): void {
    if (task.total === 0) {
      const stateColor = this.taskStateColor(task.state);
      process.stdout.write(`${stateColor}${task.state}\x1b[0m\n`);
      return;
    }

    const stateColor = this.taskStateColor(task.state);
    const stateLabel = `${stateColor}${task.state}\x1b[0m`;

    if (task.state === 'done') {
      process.stdout.write(
        `\x1b[32m✓ All ${task.total} step${task.total !== 1 ? 's' : ''} completed\x1b[0m\n`,
      );
      return;
    }

    const pct = task.total > 0 ? task.step / task.total : 0;
    const filled = Math.round(pct * 10);
    const bar = `${stateColor}${'█'.repeat(filled)}\x1b[2m${'░'.repeat(10 - filled)}\x1b[0m`;
    const stepLabel = `\x1b[2m${task.step}/${task.total}\x1b[0m`;
    const currentText = task.current ? `  \x1b[2m›\x1b[0m  \x1b[2m${task.current}\x1b[0m` : '';
    process.stdout.write(`${stateLabel}  [${bar}]  ${stepLabel}${currentText}\n`);
  }

  private taskStateColor(state: TaskState): string {
    switch (state) {
      case 'planning':   return '\x1b[34m'; // blue
      case 'execution':  return '\x1b[33m'; // yellow
      case 'validation': return '\x1b[36m'; // cyan
      case 'done':       return '\x1b[32m'; // green
      case 'paused':     return '\x1b[2m';  // dim
      default:           return '\x1b[0m';
    }
  }


}
