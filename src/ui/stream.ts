import readline from 'readline';
import { renderMarkdown } from './renderer.js';

const SPINNER_FRAMES = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];

export class StreamRenderer {
  private spinnerInterval: ReturnType<typeof setInterval> | null = null;
  private spinnerFrame = 0;
  private streaming = false;
  private rawBuffer = '';

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
      process.stdout.write('\r\x1b[K'); // clear spinner line
    }
  }

  onToken(text: string): void {
    if (!this.streaming) {
      this.stopSpinner();
      this.streaming = true;
    }
    this.rawBuffer += text;
    process.stdout.write(text);
  }

  finalize(): void {
    this.stopSpinner();
    if (this.streaming) {
      // Clear raw streamed output and re-render with markdown
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

  reset(): void {
    this.stopSpinner();
    this.rawBuffer = '';
    this.streaming = false;
  }

  showToolCall(toolName: string, args: string): void {
    this.stopSpinner();
    let prettyArgs = args;
    try {
      prettyArgs = JSON.stringify(JSON.parse(args), null, 2);
    } catch {
      // use raw
    }
    process.stdout.write(`\n\x1b[36m⚙ Calling tool: ${toolName}\x1b[0m\n${prettyArgs}\n`);
  }

  showToolResult(result: string, truncate = 500): void {
    const display = result.length > truncate ? result.slice(0, truncate) + '…' : result;
    process.stdout.write(`\x1b[2m→ ${display}\x1b[0m\n`);
  }

  showError(msg: string): void {
    process.stdout.write(`\x1b[31m✗ ${msg}\x1b[0m\n`);
  }

  showInfo(msg: string): void {
    process.stdout.write(`\x1b[33m${msg}\x1b[0m\n`);
  }
}
