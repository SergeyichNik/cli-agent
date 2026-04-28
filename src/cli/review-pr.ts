import { loadSecrets } from '../agent/secrets.js';
import { DeepSeekProvider } from '../providers/deepseek.js';
import { existsSync, readFileSync } from 'fs';
import path from 'path';
import type { Message } from '../providers/base.js';

const BASE_URL = 'https://api.github.com';

const REVIEW_SYSTEM_PROMPT = `Ты — опытный инженер, проводящий код-ревью Pull Request.
Проанализируй предоставленный diff и содержимое изменённых файлов.

Верни ревью строго в следующем Markdown-формате:

## AI Code Review {VERDICT}

### 🐛 Потенциальные баги
{список багов или "_Не обнаружено._"}

### 🏗️ Архитектурные проблемы
{список проблем или "_Не обнаружено._"}

### 💡 Рекомендации
{список рекомендаций или "_Нет дополнительных рекомендаций._"}

---
*Автоматическое ревью сгенерировано AI (DeepSeek) на основе diff и содержимого файлов.*

Правила:
- VERDICT = "✅ Выглядит хорошо" если серьёзных замечаний нет
- VERDICT = "⚠️ Есть замечания (N)" где N — суммарное количество пунктов в первых двух секциях
- Каждая секция ОБЯЗАНА присутствовать — если замечаний нет, пиши "_Не обнаружено._"
- Пиши по-русски, конкретно и по делу`;

interface PrFile {
  filename: string;
  status: string;
  additions: number;
  deletions: number;
  patch?: string;
}

async function ghGet(urlPath: string, token: string, accept = 'application/vnd.github+json'): Promise<Response> {
  return fetch(`${BASE_URL}${urlPath}`, {
    headers: {
      'Accept': accept,
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': `Bearer ${token}`,
    },
  });
}

async function ghPost(urlPath: string, token: string, body: unknown): Promise<Response> {
  return fetch(`${BASE_URL}${urlPath}`, {
    method: 'POST',
    headers: {
      'Accept': 'application/vnd.github+json',
      'X-GitHub-Api-Version': '2022-11-28',
      'Authorization': `Bearer ${token}`,
      'Content-Type': 'application/json',
    },
    body: JSON.stringify(body),
  });
}

function readLocalFile(filepath: string, sandboxDir: string): string | null {
  const fullPath = path.join(sandboxDir, filepath);
  if (!existsSync(fullPath)) return null;
  try {
    return readFileSync(fullPath, 'utf-8');
  } catch {
    return null;
  }
}

export async function runReviewPr(
  repoArg: string,
  prNumber: number,
  debug: boolean,
  sandboxDir = process.cwd(),
): Promise<void> {
  const secrets = loadSecrets();

  const githubToken = process.env.GITHUB_TOKEN ?? secrets.github?.apiKey ?? '';
  if (!githubToken) {
    console.error('GITHUB_TOKEN not found. Set it in env or ~/.config/agent/secrets.json (github.token)');
    process.exit(1);
  }

  const apiKey = process.env.DEEPSEEK_API_KEY ?? secrets.deepseek?.apiKey ?? '';
  if (!apiKey) {
    console.error('DEEPSEEK_API_KEY not found. Set it in env or ~/.config/agent/secrets.json');
    process.exit(1);
  }

  const [owner, repo] = repoArg.split('/');

  console.log(`\n\x1b[1mAI Code Review\x1b[0m — ${repoArg} #${prNumber}\n`);

  // 1. Fetch diff
  process.stdout.write('  Fetching diff...');
  const diffRes = await ghGet(
    `/repos/${owner}/${repo}/pulls/${prNumber}`,
    githubToken,
    'application/vnd.github.diff',
  );
  if (!diffRes.ok) {
    const body = await diffRes.text();
    console.error(`\n  GitHub error ${diffRes.status}: ${body}`);
    process.exit(1);
  }
  const diff = await diffRes.text();
  console.log(` \x1b[32m✓\x1b[0m  (${diff.split('\n').length} lines)`);

  // 2. Fetch changed files
  process.stdout.write('  Fetching changed files...');
  const filesRes = await ghGet(`/repos/${owner}/${repo}/pulls/${prNumber}/files`, githubToken);
  if (!filesRes.ok) {
    const body = await filesRes.text();
    console.error(`\n  GitHub error ${filesRes.status}: ${body}`);
    process.exit(1);
  }
  const changedFiles = await filesRes.json() as PrFile[];
  console.log(` \x1b[32m✓\x1b[0m  (${changedFiles.length} files)`);

  for (const f of changedFiles) {
    const icon = f.status === 'added' ? '\x1b[32m+\x1b[0m' : f.status === 'removed' ? '\x1b[31m-\x1b[0m' : '\x1b[33m~\x1b[0m';
    console.log(`    ${icon} ${f.filename}  \x1b[2m(+${f.additions}/-${f.deletions})\x1b[0m`);
  }

  // 3. Read local file contents for context
  const fileContents: string[] = [];
  const readableFiles = changedFiles.filter(f => f.status !== 'removed');
  if (readableFiles.length > 0) {
    process.stdout.write('  Reading local files...');
    let readCount = 0;
    for (const f of readableFiles) {
      const content = readLocalFile(f.filename, sandboxDir);
      if (content) {
        fileContents.push(`--- ${f.filename} ---\n${content.slice(0, 4000)}`);
        readCount++;
      }
    }
    console.log(` \x1b[32m✓\x1b[0m  (${readCount}/${readableFiles.length} read)`);
  }

  // 4. Build prompt
  const contextParts: string[] = [
    `## Diff PR #${prNumber} (${repoArg})\n\`\`\`diff\n${diff.slice(0, 6000)}\n\`\`\``,
  ];
  if (fileContents.length > 0) {
    contextParts.push(`## Содержимое изменённых файлов\n${fileContents.join('\n\n')}`);
  }
  const userMessage = contextParts.join('\n\n') + '\n\nПроведи ревью этого PR.';

  const messages: Message[] = [
    { role: 'system', content: REVIEW_SYSTEM_PROMPT },
    { role: 'user', content: userMessage },
  ];

  // 5. Generate review
  console.log('\n  Generating review...\n');
  const deepseek = new DeepSeekProvider(apiKey, 'deepseek-chat');
  let reviewText = '';

  const frames = ['⠋', '⠙', '⠹', '⠸', '⠼', '⠴', '⠦', '⠧', '⠇', '⠏'];
  let frameIdx = 0;
  const spinInterval = setInterval(() => {
    process.stdout.write(`\r  \x1b[36m${frames[frameIdx++ % frames.length]}\x1b[0m Thinking...`);
  }, 80);

  let firstToken = true;
  for await (const chunk of deepseek.stream(messages, { temperature: 0.1 })) {
    if (chunk.type === 'text') {
      if (firstToken) {
        clearInterval(spinInterval);
        process.stdout.write('\r\x1b[K');
        firstToken = false;
      }
      process.stdout.write(chunk.text);
      reviewText += chunk.text;
    }
  }
  if (firstToken) clearInterval(spinInterval);
  console.log('\n');

  if (!reviewText) {
    console.error('  No review generated.');
    process.exit(1);
  }

  // 6. Post comment to PR
  process.stdout.write('  Posting PR comment...');
  const postRes = await ghPost(`/repos/${owner}/${repo}/issues/${prNumber}/comments`, githubToken, { body: reviewText });

  if (!postRes.ok) {
    const errBody = await postRes.text();
    if (debug) console.error(`\n  GitHub error ${postRes.status}: ${errBody}`);
    console.log(` \x1b[33m⚠ Could not post comment (${postRes.status})\x1b[0m`);
  } else {
    const result = await postRes.json() as { html_url: string };
    console.log(` \x1b[32m✓\x1b[0m`);
    console.log(`\n  \x1b[1mComment:\x1b[0m \x1b[36m${result.html_url}\x1b[0m\n`);
  }
}
