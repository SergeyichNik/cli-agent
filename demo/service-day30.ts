/*
 * День 30 — Локальная LLM как приватный сервис
 *
 * Архитектура: LM Studio (домашняя машина) → SSH reverse tunnel → VPS → nginx → этот сервер
 *
 * ═══════════════════════════════════════════════════════════════════
 * ИНФРАСТРУКТУРА
 * ═══════════════════════════════════════════════════════════════════
 *
 * 1. Домашняя машина — autossh туннель (systemd user service)
 *    Файл: ~/.config/systemd/user/lm-tunnel.service
 *
 *    [Unit]
 *    Description=LM Studio SSH Reverse Tunnel
 *    After=network-online.target
 *
 *    [Service]
 *    ExecStart=autossh -M 0 -N -R 1234:localhost:1234 user@VPS_IP \
 *      -o ServerAliveInterval=30 -o ServerAliveCountMax=3
 *    Restart=always
 *    RestartSec=10
 *
 *    [Install]
 *    WantedBy=default.target
 *
 *    Активация:
 *    systemctl --user enable --now lm-tunnel
 *
 * 2. VPS — nginx /etc/nginx/sites-available/llm-service
 *
 *    server {
 *        listen 80;
 *        server_name YOUR_VPS_IP;
 *        location / {
 *            proxy_pass http://127.0.0.1:3000;
 *            proxy_set_header X-Real-IP $remote_addr;
 *            proxy_set_header Connection '';
 *            proxy_buffering off;
 *            chunked_transfer_encoding on;
 *        }
 *    }
 *
 *    ln -s /etc/nginx/sites-available/llm-service /etc/nginx/sites-enabled/
 *    nginx -t && systemctl reload nginx
 *
 * 3. VPS — запуск сервиса
 *    API_KEY=your-secret LM_STUDIO_URL=http://localhost:1234 npm run demo:day30
 *
 * 4. Проверка:
 *    curl http://VPS_IP/health
 *    open http://VPS_IP/
 *
 * ═══════════════════════════════════════════════════════════════════
 * ENV
 * ═══════════════════════════════════════════════════════════════════
 *    PORT           — порт сервиса (default: 3000)
 *    API_KEY        — Bearer токен для аутентификации (default: changeme)
 *    LM_STUDIO_URL  — URL LM Studio (default: http://localhost:1234)
 *    MODEL          — имя модели для /health (default: local-model)
 */

import { Hono } from 'hono';
import { serve } from '@hono/node-server';

// ── Config ────────────────────────────────────────────────────────────────────
const PORT = parseInt(process.env.PORT ?? '3000');
const API_KEY = process.env.API_KEY ?? 'changeme';
const LM_STUDIO_URL = process.env.LM_STUDIO_URL ?? 'http://localhost:1234';
const MODEL = process.env.MODEL ?? 'local-model';
const MAX_INPUT_CHARS = 8_000;
const RATE_LIMIT_MAX = 10;
const RATE_LIMIT_WINDOW_MS = 60_000;

// ── Rate limiter ──────────────────────────────────────────────────────────────
class RateLimiter {
  private map = new Map<string, { count: number; resetAt: number }>();

  check(ip: string): boolean {
    const now = Date.now();
    const entry = this.map.get(ip);
    if (!entry || now > entry.resetAt) {
      this.map.set(ip, { count: 1, resetAt: now + RATE_LIMIT_WINDOW_MS });
      return true;
    }
    if (entry.count >= RATE_LIMIT_MAX) return false;
    entry.count++;
    return true;
  }

  status(ip: string): { remaining: number; resetIn: number } {
    const entry = this.map.get(ip);
    if (!entry || Date.now() > entry.resetAt) return { remaining: RATE_LIMIT_MAX, resetIn: 0 };
    return {
      remaining: Math.max(0, RATE_LIMIT_MAX - entry.count),
      resetIn: Math.ceil((entry.resetAt - Date.now()) / 1000),
    };
  }
}

const limiter = new RateLimiter();

// ── Chat HTML ─────────────────────────────────────────────────────────────────
function chatHtml(apiKey: string): string {
  return `<!DOCTYPE html>
<html lang="ru">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Private LLM Chat — Day 30</title>
  <style>
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body { font-family: system-ui, sans-serif; background: #0f0f0f; color: #e8e8e8; height: 100vh; display: flex; flex-direction: column; }
    header { padding: 16px 24px; background: #1a1a1a; border-bottom: 1px solid #2a2a2a; display: flex; align-items: center; gap: 12px; }
    header h1 { font-size: 16px; font-weight: 600; }
    .badge { font-size: 11px; background: #1a3a1a; color: #4ade80; border: 1px solid #2d5a2d; padding: 2px 8px; border-radius: 999px; }
    #messages { flex: 1; overflow-y: auto; padding: 24px; display: flex; flex-direction: column; gap: 16px; }
    .msg { max-width: 80%; line-height: 1.6; }
    .msg.user { align-self: flex-end; background: #1e3a5f; padding: 10px 14px; border-radius: 12px 12px 2px 12px; }
    .msg.assistant { align-self: flex-start; background: #1a1a1a; border: 1px solid #2a2a2a; padding: 10px 14px; border-radius: 12px 12px 12px 2px; white-space: pre-wrap; }
    .msg.error { align-self: center; color: #f87171; font-size: 13px; }
    .cursor { display: inline-block; width: 8px; height: 14px; background: #4ade80; animation: blink 0.8s step-end infinite; vertical-align: middle; }
    @keyframes blink { 50% { opacity: 0; } }
    footer { padding: 16px 24px; background: #1a1a1a; border-top: 1px solid #2a2a2a; display: flex; gap: 10px; }
    textarea { flex: 1; background: #0f0f0f; border: 1px solid #2a2a2a; border-radius: 8px; color: #e8e8e8; padding: 10px 14px; font-size: 14px; resize: none; height: 44px; outline: none; font-family: inherit; }
    textarea:focus { border-color: #3b82f6; }
    button { background: #3b82f6; color: white; border: none; padding: 0 20px; border-radius: 8px; cursor: pointer; font-size: 14px; font-weight: 500; white-space: nowrap; }
    button:disabled { background: #1e3a5f; color: #4a6a8a; cursor: not-allowed; }
    button:hover:not(:disabled) { background: #2563eb; }
  </style>
</head>
<body>
<header>
  <h1>Private LLM</h1>
  <span class="badge">● online</span>
  <span style="margin-left:auto;font-size:12px;color:#666">Day 30 · local model via SSH tunnel</span>
</header>
<div id="messages">
  <div class="msg assistant">Привет! Я локальная LLM, развёрнутая как приватный сервис. Чем могу помочь?</div>
</div>
<footer>
  <textarea id="input" placeholder="Введите сообщение... (Enter — отправить, Shift+Enter — новая строка)" rows="1"></textarea>
  <button id="btn">Отправить</button>
</footer>

<script>
  const API_KEY = ${JSON.stringify(apiKey)};
  const messages = [];
  const input = document.getElementById('input');
  const btn = document.getElementById('btn');
  const container = document.getElementById('messages');

  input.addEventListener('keydown', (e) => {
    if (e.key === 'Enter' && !e.shiftKey) { e.preventDefault(); send(); }
  });
  btn.addEventListener('click', send);

  function addMsg(role, content) {
    const div = document.createElement('div');
    div.className = 'msg ' + role;
    div.textContent = content;
    container.appendChild(div);
    container.scrollTop = container.scrollHeight;
    return div;
  }

  async function send() {
    const text = input.value.trim();
    if (!text) return;

    input.value = '';
    input.disabled = true;
    btn.disabled = true;

    addMsg('user', text);
    messages.push({ role: 'user', content: text });

    const assistantDiv = addMsg('assistant', '');
    const cursor = document.createElement('span');
    cursor.className = 'cursor';
    assistantDiv.appendChild(cursor);

    let fullText = '';

    try {
      const res = await fetch('/v1/chat/completions', {
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          'Authorization': 'Bearer ' + API_KEY,
        },
        body: JSON.stringify({ messages, stream: true }),
      });

      if (!res.ok) {
        const err = await res.json().catch(() => ({ error: res.statusText }));
        assistantDiv.className = 'msg error';
        assistantDiv.textContent = '⚠ ' + (err.error ?? res.statusText);
        messages.pop();
        return;
      }

      const reader = res.body.getReader();
      const decoder = new TextDecoder();
      let buffer = '';

      while (true) {
        const { done, value } = await reader.read();
        if (done) break;

        buffer += decoder.decode(value, { stream: true });
        const lines = buffer.split('\\n');
        buffer = lines.pop() ?? '';

        for (const line of lines) {
          if (!line.startsWith('data: ')) continue;
          const data = line.slice(6).trim();
          if (data === '[DONE]') continue;
          try {
            const chunk = JSON.parse(data);
            const delta = chunk.choices?.[0]?.delta?.content ?? '';
            if (delta) {
              fullText += delta;
              assistantDiv.textContent = fullText;
              assistantDiv.appendChild(cursor);
              container.scrollTop = container.scrollHeight;
            }
          } catch {}
        }
      }

      cursor.remove();
      messages.push({ role: 'assistant', content: fullText });

    } catch (err) {
      assistantDiv.className = 'msg error';
      assistantDiv.textContent = '⚠ ' + err.message;
      messages.pop();
    } finally {
      input.disabled = false;
      btn.disabled = false;
      input.focus();
    }
  }
</script>
</body>
</html>`;
}

// ── App ───────────────────────────────────────────────────────────────────────
const app = new Hono();

app.get('/health', (c) => {
  return c.json({
    status: 'ok',
    model: MODEL,
    upstream: LM_STUDIO_URL,
    limits: {
      rateLimit: `${RATE_LIMIT_MAX} req/min per IP`,
      maxInputChars: MAX_INPUT_CHARS,
      maxOutputTokens: 2048,
    },
  });
});

app.get('/', (c) => {
  return c.html(chatHtml(API_KEY));
});

app.post('/v1/chat/completions', async (c) => {
  // Auth
  const auth = c.req.header('Authorization');
  if (!auth || auth !== `Bearer ${API_KEY}`) {
    return c.json({ error: 'Unauthorized' }, 401);
  }

  // Rate limit
  const ip =
    c.req.header('X-Real-IP') ??
    c.req.header('X-Forwarded-For')?.split(',')[0].trim() ??
    'unknown';

  if (!limiter.check(ip)) {
    const { resetIn } = limiter.status(ip);
    return c.json(
      { error: `Too many requests. Limit: ${RATE_LIMIT_MAX} req/min`, retryAfter: resetIn },
      429,
    );
  }

  // Parse body
  let body: Record<string, unknown>;
  try {
    body = await c.req.json();
  } catch {
    return c.json({ error: 'Invalid JSON body' }, 400);
  }

  // Input size guard
  const messages = (body.messages as Array<{ role: string; content: string }>) ?? [];
  const totalChars = messages.reduce((sum, m) => sum + (m.content?.length ?? 0), 0);
  if (totalChars > MAX_INPUT_CHARS) {
    return c.json(
      { error: `Input too large: ${totalChars} chars (max ${MAX_INPUT_CHARS})` },
      400,
    );
  }

  // Log
  const preview = messages.at(-1)?.content?.slice(0, 60) ?? '';
  console.log(`[${new Date().toISOString()}] ${ip} | ${totalChars} chars | "${preview}..."`);

  // Proxy to LM Studio
  let upstream: Response;
  try {
    upstream = await fetch(`${LM_STUDIO_URL}/v1/chat/completions`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({
        ...body,
        max_tokens: body.max_tokens ?? 2048,
      }),
    });
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`[upstream error] ${msg}`);
    return c.json({ error: `LM Studio unreachable: ${msg}` }, 502);
  }

  if (!upstream.ok) {
    const text = await upstream.text().catch(() => '');
    return c.json({ error: `Upstream error ${upstream.status}`, detail: text }, 502);
  }

  return new Response(upstream.body, {
    status: 200,
    headers: {
      'Content-Type': upstream.headers.get('Content-Type') ?? 'text/event-stream',
      'Cache-Control': 'no-cache',
      'X-Accel-Buffering': 'no',
    },
  });
});

// ── Start ─────────────────────────────────────────────────────────────────────
serve({ fetch: app.fetch, port: PORT }, () => {
  console.log(`
╔════════════════════════════════════════╗
║      Private LLM Service — Day 30      ║
╚════════════════════════════════════════╝

  Chat UI  : http://localhost:${PORT}/
  API      : POST http://localhost:${PORT}/v1/chat/completions
  Health   : http://localhost:${PORT}/health

  Upstream : ${LM_STUDIO_URL}
  Auth     : Bearer ${API_KEY.slice(0, 4)}${'*'.repeat(Math.max(0, API_KEY.length - 4))}
  Rate     : ${RATE_LIMIT_MAX} req/min per IP
  Max input: ${MAX_INPUT_CHARS} chars
  Max out  : 2048 tokens

  curl example:
    curl -s http://localhost:${PORT}/v1/chat/completions \\
      -H "Authorization: Bearer ${API_KEY}" \\
      -H "Content-Type: application/json" \\
      -d '{"messages":[{"role":"user","content":"ping"}],"stream":false}'
`);
});
