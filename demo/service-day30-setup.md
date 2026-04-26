# День 30 — Развёртывание приватного LLM-сервиса

Пошаговая инструкция для схемы:

```
Браузер/curl
     │
     ▼
VPS:80 (nginx)
     │ proxy_pass
     ▼
VPS:3000 (Hono — demo/service-day30.ts)
     │ fetch
     ▼
VPS:1234 (SSH reverse tunnel)
     │ зашифрованный туннель
     ▼
Home:1234 (LM Studio + Qwen 14B)
```

---

## Фаза 1 — Арендуй VPS

Рекомендую **Hetzner** (hetzner.com → Cloud → Create Server):

- Location: Nuremberg или Helsinki
- Image: **Ubuntu 24.04**
- Type: **CX22** (~4€/мес, 2 vCPU, 4 GB RAM)
- SSH Keys: добавь публичный ключ при создании

Сохрани выданный IP — далее везде `VPS_IP`.

---

## Фаза 2 — SSH ключ (если нет)

```bash
# Проверь
cat ~/.ssh/id_ed25519.pub

# Если нет — создай
ssh-keygen -t ed25519 -C "home-machine" -f ~/.ssh/id_ed25519 -N ""

# Скопируй и вставь в Hetzner при создании сервера
cat ~/.ssh/id_ed25519.pub
```

---

## Фаза 3 — Первый вход, создание пользователя

```bash
ssh root@VPS_IP

apt update && apt upgrade -y

adduser llm
usermod -aG sudo llm

mkdir -p /home/llm/.ssh
cp /root/.ssh/authorized_keys /home/llm/.ssh/
chown -R llm:llm /home/llm/.ssh
chmod 700 /home/llm/.ssh
chmod 600 /home/llm/.ssh/authorized_keys

exit
```

```bash
ssh llm@VPS_IP
```

---

## Фаза 4 — Установка зависимостей на VPS

```bash
# nginx
sudo apt install -y nginx git

# Node.js 22
curl -fsSL https://deb.nodesource.com/setup_22.x | sudo -E bash -
sudo apt install -y nodejs

# Проверь версии
node --version   # v22.x.x
nginx -v         # nginx/1.24.x
```

---

## Фаза 5 — Разрешить SSH reverse tunnel на VPS

```bash
sudo nano /etc/ssh/sshd_config
```

Найди и установи:
```
GatewayPorts no
AllowTcpForwarding yes
```

```bash
sudo systemctl restart sshd
```

---

## Фаза 6 — Клонируй репозиторий на VPS

```bash
git clone https://github.com/SergeyichNik/cli-agent.git
cd cli-agent

# Переключись на ветку с Day 30
git checkout feat/day29-code-review-benchmark

npm install
```

---

## Фаза 7 — Настройка nginx на VPS

```bash
sudo nano /etc/nginx/sites-available/llm-service
```

Содержимое (замени `VPS_IP` на реальный IP):
```nginx
server {
    listen 80;
    server_name VPS_IP;

    location / {
        proxy_pass http://127.0.0.1:3000;
        proxy_set_header X-Real-IP $remote_addr;
        proxy_set_header X-Forwarded-For $proxy_add_x_forwarded_for;
        proxy_set_header Host $host;

        proxy_set_header Connection '';
        proxy_http_version 1.1;
        proxy_buffering off;
        chunked_transfer_encoding on;
        proxy_read_timeout 300s;
    }
}
```

```bash
sudo ln -s /etc/nginx/sites-available/llm-service /etc/nginx/sites-enabled/
sudo rm -f /etc/nginx/sites-enabled/default

sudo nginx -t
sudo systemctl enable --now nginx
```

---

## Фаза 8 — SSH reverse tunnel на домашней машине

> LM Studio должен быть запущен и слушать порт 1234.

```bash
# Установи autossh
brew install autossh   # macOS
# sudo apt install autossh  # Linux

# Проверь туннель вручную
autossh -M 0 -N \
  -R 1234:localhost:1234 llm@VPS_IP \
  -o ServerAliveInterval=30 \
  -o ServerAliveCountMax=3 \
  -o ExitOnForwardFailure=yes

# Проверь с VPS (в другом терминале):
ssh llm@VPS_IP "curl -s http://localhost:1234/v1/models"
# Должен вернуть JSON с моделями из LM Studio
```

### Автозапуск туннеля — macOS LaunchAgent

Создай `~/Library/LaunchAgents/com.llm.tunnel.plist` (замени `VPS_IP`):

```xml
<?xml version="1.0" encoding="UTF-8"?>
<!DOCTYPE plist PUBLIC "-//Apple//DTD PLIST 1.0//EN"
  "http://www.apple.com/DTDs/PropertyList-1.0.dtd">
<plist version="1.0">
<dict>
    <key>Label</key>
    <string>com.llm.tunnel</string>
    <key>ProgramArguments</key>
    <array>
        <string>/opt/homebrew/bin/autossh</string>
        <string>-M</string><string>0</string>
        <string>-N</string>
        <string>-R</string><string>1234:localhost:1234</string>
        <string>llm@VPS_IP</string>
        <string>-o</string><string>ServerAliveInterval=30</string>
        <string>-o</string><string>ServerAliveCountMax=3</string>
        <string>-o</string><string>ExitOnForwardFailure=yes</string>
    </array>
    <key>RunAtLoad</key>
    <true/>
    <key>KeepAlive</key>
    <true/>
    <key>StandardErrorPath</key>
    <string>/tmp/lm-tunnel.log</string>
</dict>
</plist>
```

```bash
launchctl load ~/Library/LaunchAgents/com.llm.tunnel.plist
launchctl start com.llm.tunnel

# Проверь статус
launchctl list | grep llm
# Лог если что-то не так:
cat /tmp/lm-tunnel.log
```

---

## Фаза 9 — Запуск сервиса на VPS

```bash
# Установи screen для работы в фоне
sudo apt install -y screen

# Создай сессию
screen -S llm-service

# Внутри screen (замени значения):
cd ~/cli-agent
API_KEY=твой-секретный-ключ \
LM_STUDIO_URL=http://localhost:1234 \
MODEL="Qwen2.5-Coder-14B" \
npm run demo:day30

# Отсоединись: Ctrl+A, затем D
# Вернуться к логам: screen -r llm-service
```

---

## Фаза 10 — Проверка

```bash
# С любой машины (замени VPS_IP и ключ):

# 1. Health
curl http://VPS_IP/health

# 2. API запрос
curl -X POST http://VPS_IP/v1/chat/completions \
  -H "Authorization: Bearer твой-ключ" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Напиши hello world на Python"}],"stream":false}'

# 3. Rate limit — 11-й запрос должен вернуть 429
for i in {1..11}; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" \
    -X POST http://VPS_IP/v1/chat/completions \
    -H "Authorization: Bearer твой-ключ" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"hi"}],"stream":false}')
  echo "req $i: $CODE"
done

# 4. Max context — должен вернуть 400
BIG=$(python3 -c "print('x'*9000)")
curl -X POST http://VPS_IP/v1/chat/completions \
  -H "Authorization: Bearer твой-ключ" \
  -H "Content-Type: application/json" \
  -d "{\"messages\":[{\"role\":\"user\",\"content\":\"$BIG\"}]}"

# 5. Чат в браузере
open http://VPS_IP/
```

---

## Диагностика

| Проблема | Что проверить |
|---|---|
| nginx не отвечает | `sudo systemctl status nginx` → `sudo nginx -t` |
| 502 от сервиса | LM Studio запущен? Туннель поднят? |
| Туннель не работает | `ssh llm@VPS_IP "curl localhost:1234/v1/models"` |
| macOS туннель не стартует | `cat /tmp/lm-tunnel.log` |
| screen сессия пропала | `screen -ls` → `screen -r <id>` |
