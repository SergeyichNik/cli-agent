import { get_encoding } from 'tiktoken';
import path from 'path';

const enc = get_encoding('cl100k_base');

export interface RawChunk {
  content: string;
  section: string;
  chunkIndex: number;
  tokenCount: number;
}

// ---------------------------------------------------------------------------
// Strategy A: Fixed-size (512 tokens, 50-token overlap)
// ---------------------------------------------------------------------------

const FIXED_LIMIT = 512;
const FIXED_OVERLAP = 50;

export function chunkFixed(text: string): RawChunk[] {
  const tokens = enc.encode(text);
  const decoder = new TextDecoder();
  const chunks: RawChunk[] = [];

  // Find the nearest heading before a given token offset by scanning the text
  function findSection(charPos: number): string {
    const before = text.slice(0, charPos);
    const lines = before.split('\n');
    for (let i = lines.length - 1; i >= 0; i--) {
      if (/^#{1,3} /.test(lines[i])) {
        return lines[i].replace(/^#+\s*/, '');
      }
    }
    return '';
  }

  const step = FIXED_LIMIT - FIXED_OVERLAP;
  let chunkIndex = 0;

  for (let start = 0; start < tokens.length; start += step) {
    const end = Math.min(start + FIXED_LIMIT, tokens.length);
    const sliceTokens = tokens.slice(start, end);
    const content = decoder.decode(enc.decode(sliceTokens)).trim();
    if (content.length === 0) continue;

    // Estimate char position to find nearest heading
    const charRatio = start / tokens.length;
    const approxCharPos = Math.floor(charRatio * text.length);
    const section = findSection(approxCharPos);

    chunks.push({ content, section, chunkIndex: chunkIndex++, tokenCount: sliceTokens.length });

    if (end === tokens.length) break;
  }

  return chunks;
}

// ---------------------------------------------------------------------------
// Strategy B: Structural (by headings for .md, by top-level exports for .ts)
// ---------------------------------------------------------------------------

const STRUCTURAL_WARN_TOKENS = 1500;

// Conservative limit safe for 512-context models (mxbai-embed-large).
// For nomic-embed-text (2048 ctx) you can raise this in config.
const MAX_EMBED_TOKENS = 400;

export function truncateToTokens(text: string, maxTokens = MAX_EMBED_TOKENS): string {
  const tokens = enc.encode(text);
  if (tokens.length <= maxTokens) return text;
  const truncated = tokens.slice(0, maxTokens);
  return new TextDecoder().decode(enc.decode(truncated));
}

export function chunkStructural(text: string, source: string): RawChunk[] {
  const ext = path.extname(source).toLowerCase();
  if (['.md', '.txt', '.rst'].includes(ext)) {
    return splitMarkdown(text);
  }
  return splitCode(text);
}

function countTokens(text: string): number {
  return enc.encode(text).length;
}

function splitMarkdown(text: string): RawChunk[] {
  const lines = text.split('\n');
  const chunks: RawChunk[] = [];
  let currentSection = '';
  let currentLines: string[] = [];
  let chunkIndex = 0;

  function flush(): void {
    const content = currentLines.join('\n').trim();
    if (content.length === 0) return;
    const tokenCount = countTokens(content);
    if (tokenCount > STRUCTURAL_WARN_TOKENS) {
      process.stderr.write(`[search] Warning: structural chunk "${currentSection}" is ${tokenCount} tokens (>${STRUCTURAL_WARN_TOKENS})\n`);
    }
    chunks.push({ content, section: currentSection, chunkIndex: chunkIndex++, tokenCount });
    currentLines = [];
  }

  for (const line of lines) {
    if (/^#{1,3} /.test(line)) {
      flush();
      currentSection = line.replace(/^#+\s*/, '');
      currentLines.push(line);
    } else {
      currentLines.push(line);
    }
  }
  flush();
  return chunks;
}

// Top-level TypeScript/JavaScript declaration patterns
const TOP_LEVEL_RE = /^(?:export\s+)?(?:default\s+)?(?:async\s+)?(?:function|class|interface|const|let|var|type|enum|abstract\s+class)\s+(\w+)/;

function splitCode(text: string): RawChunk[] {
  const lines = text.split('\n');
  const chunks: RawChunk[] = [];
  let currentSection = '';
  let currentLines: string[] = [];
  let chunkIndex = 0;

  function flush(): void {
    const content = currentLines.join('\n').trim();
    if (content.length < 10) return;
    const tokenCount = countTokens(content);
    if (tokenCount > STRUCTURAL_WARN_TOKENS) {
      process.stderr.write(`[search] Warning: structural chunk "${currentSection}" is ${tokenCount} tokens (>${STRUCTURAL_WARN_TOKENS})\n`);
    }
    chunks.push({ content, section: currentSection, chunkIndex: chunkIndex++, tokenCount });
    currentLines = [];
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    const match = TOP_LEVEL_RE.exec(line);
    const prevIsEmpty = i > 0 && lines[i - 1].trim() === '';

    if (match && prevIsEmpty && currentLines.length > 0) {
      flush();
      currentSection = match[1] ?? line.slice(0, 60).trim();
    } else if (match && currentLines.length === 0) {
      currentSection = match[1] ?? line.slice(0, 60).trim();
    }

    currentLines.push(line);
  }
  flush();

  return chunks;
}
