import { marked } from 'marked';
// @ts-expect-error — marked-terminal has no types
import TerminalRenderer from 'marked-terminal';

marked.setOptions({ renderer: new TerminalRenderer() });

export function renderMarkdown(text: string): string {
  return marked(text) as string;
}
