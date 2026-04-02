import readline from 'readline';
import { renderMarkdown } from './renderer.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class StreamRenderer {
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private streaming = false;
  private rawBuffer = '';

  // Token tracking
  private outputEstimate = 0;   // chars/4 estimate during streaming
  private startTime = 0;
  private isTTY = process.stdout.isTTY ?? false;

  // --- Spinner ---

  startSpinner(label = 'Thinking'): void {
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

  // --- Live counter (bottom row of terminal) ---

  private writeLiveCounter(): void {
    if (!this.isTTY) return;
    const rows = process.stdout.rows;
    if (!rows) return;
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const label = `\x1b[2m↓ ~${this.outputEstimate} tokens  ${elapsed}s\x1b[0m`;
    process.stdout.write(`\x1b[s\x1b[${rows};1H\r\x1b[2K${label}\x1b[u`);
  }

  private clearLiveCounter(): void {
    if (!this.isTTY) return;
    const rows = process.stdout.rows;
    if (!rows) return;
    process.stdout.write(`\x1b[s\x1b[${rows};1H\r\x1b[2K\x1b[u`);
  }

  // --- Streaming ---

  onToken(text: string): void {
    if (!this.streaming) {
      this.stopSpinner();
      this.streaming = true;
      this.startTime = Date.now();
      this.outputEstimate = 0;
    }
    this.rawBuffer += text;
    this.outputEstimate += Math.ceil(text.length / 4);
    process.stdout.write(text);
    this.writeLiveCounter();
  }

  finalize(): void {
    this.stopSpinner();
    this.clearLiveCounter();

    if (this.streaming) {
      const lineCount = this.rawBuffer.split('\n').length;
      for (let i = 0; i < lineCount; i++) {
        readline.moveCursor(process.stdout, 0, -1);
        readline.clearLine(process.stdout, 0);
      }
      process.stdout.write(renderMarkdown(this.rawBuffer));
    }

    this.rawBuffer = '';
    this.streaming = false;
  }

  showStats(inputTokens: number, outputTokens: number): void {
    const elapsed = ((Date.now() - this.startTime) / 1000).toFixed(1);
    const sep = '\x1b[2m─\x1b[0m';
    const stats = [
      `\x1b[2m↑\x1b[0m ${inputTokens.toLocaleString()}`,
      `\x1b[2m↓\x1b[0m ${outputTokens.toLocaleString()}`,
      `\x1b[2m${elapsed}s\x1b[0m`,
    ].join('  ');
    process.stdout.write(`${sep} ${stats}\n`);
  }

  reset(): void {
    this.stopSpinner();
    this.clearLiveCounter();
    this.rawBuffer = '';
    this.streaming = false;
    this.outputEstimate = 0;
  }

  // --- Tool output ---

  showToolCall(toolName: string, args: string): void {
    this.stopSpinner();
    this.clearLiveCounter();
    let prettyArgs = args;
    try {
      prettyArgs = JSON.stringify(JSON.parse(args), null, 2);
    } catch { /* use raw */ }
    process.stdout.write(`\n\x1b[36m⚙ ${toolName}\x1b[0m\n\x1b[2m${prettyArgs}\x1b[0m\n`);
  }

  showToolResult(result: string, truncate = 500): void {
    const display = result.length > truncate ? result.slice(0, truncate) + '…' : result;
    process.stdout.write(`\x1b[2m→ ${display}\x1b[0m\n`);
  }

  showError(msg: string): void {
    this.clearLiveCounter();
    process.stdout.write(`\x1b[31m✗ ${msg}\x1b[0m\n`);
  }

  showInfo(msg: string): void {
    process.stdout.write(`\x1b[33m${msg}\x1b[0m\n`);
  }
}
