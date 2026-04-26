#!/bin/bash
# День 30 — Сценарий демонстрации приватного LLM-сервиса
# Запуск: bash ~/Documents/cli-agent/demo/scenarios/day30-test.sh

VPS_IP="147.45.100.155"
API_KEY="llm12345"
BASE_URL="http://$VPS_IP"

echo "╔════════════════════════════════════════╗"
echo "║     Day 30 — LLM Service Demo Test     ║"
echo "╚════════════════════════════════════════╝"
echo ""

# ── 1. Health ─────────────────────────────────────────────────────────────────
echo "━━━ 1. Доступ к сервису по сети ━━━"
curl -s "$BASE_URL/health" | python3 -m json.tool
echo ""

# ── 2. Одиночный запрос ───────────────────────────────────────────────────────
echo "━━━ 2. Одиночный API запрос ━━━"
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Напиши hello world на Python"}],"stream":false}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])"
echo ""

# ── 3. Стабильность — 5 параллельных запросов ─────────────────────────────────
echo "━━━ 3. Стабильность — 5 параллельных запросов ━━━"
for i in {1..5}; do
  BODY="{\"messages\":[{\"role\":\"user\",\"content\":\"Вопрос $i: что такое рекурсия?\"}],\"stream\":false}"
  (
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/chat/completions" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "$BODY")
    echo "  запрос $i: $CODE"
  ) &
done
wait
echo "  Все 5 запросов завершены"
echo ""

# ── 4. Rate limit ─────────────────────────────────────────────────────────────
echo "━━━ 4. Rate limit (10 req/min — 11-й должен получить 429) ━━━"
for i in {1..11}; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/chat/completions" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"hi"}],"stream":false}')
  if [ "$CODE" = "429" ]; then
    echo "  req $i: $CODE ← rate limit сработал"
  else
    echo "  req $i: $CODE"
  fi
done
echo ""

# ── 5. Max context ────────────────────────────────────────────────────────────
echo "━━━ 5. Max context (9000 символов — должен вернуть 400) ━━━"
BIG=$(python3 -c "print('x'*9000)")
BODY="{\"messages\":[{\"role\":\"user\",\"content\":\"$BIG\"}],\"stream\":false}"
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" | python3 -m json.tool
echo ""

echo "✓ Демонстрация завершена"
echo "  Чат в браузере: open $BASE_URL/"
