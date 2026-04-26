#!/bin/bash
# День 30 — Сценарий демонстрации приватного LLM-сервиса
# Запуск: bash ~/Documents/cli-agent/demo/scenarios/day30-test.sh

VPS_IP="147.45.100.155"
API_KEY="llm12345"
BASE_URL="http://$VPS_IP"

GRAY="\033[90m"
CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
BOLD="\033[1m"
RESET="\033[0m"

print_request() {
  echo -e "${GRAY}▶ запрос:${RESET}"
  echo -e "${CYAN}$1${RESET}"
  echo -e "${GRAY}▶ ответ:${RESET}"
}

echo ""
echo -e "${BOLD}╔════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║     Day 30 — LLM Service Demo Test     ║${RESET}"
echo -e "${BOLD}╚════════════════════════════════════════╝${RESET}"
echo ""

# ── 1. Health ─────────────────────────────────────────────────────────────────
echo -e "${BOLD}━━━ 1. Доступ к сервису по сети ━━━${RESET}"
print_request "curl $BASE_URL/health"
curl -s "$BASE_URL/health" | python3 -m json.tool
echo ""

# ── 2. Одиночный запрос ───────────────────────────────────────────────────────
echo -e "${BOLD}━━━ 2. Одиночный API запрос ━━━${RESET}"
print_request "curl -X POST $BASE_URL/v1/chat/completions \\
  -H \"Authorization: Bearer $API_KEY\" \\
  -d '{\"messages\":[{\"role\":\"user\",\"content\":\"Напиши hello world на Python\"}]}'"
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d '{"messages":[{"role":"user","content":"Напиши hello world на Python"}],"stream":false}' \
  | python3 -c "import sys,json; d=json.load(sys.stdin); print(d['choices'][0]['message']['content'])"
echo ""

# ── 3. Стабильность — 5 параллельных запросов ─────────────────────────────────
echo -e "${BOLD}━━━ 3. Стабильность — 5 параллельных запросов ━━━${RESET}"
print_request "for i in {1..5}; do curl -X POST $BASE_URL/v1/chat/completions ... & done"
for i in {1..5}; do
  BODY="{\"messages\":[{\"role\":\"user\",\"content\":\"Вопрос $i: что такое рекурсия?\"}],\"stream\":false}"
  (
    CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/chat/completions" \
      -H "Authorization: Bearer $API_KEY" \
      -H "Content-Type: application/json" \
      -d "$BODY")
    echo -e "  запрос $i: ${GREEN}$CODE OK${RESET}"
  ) &
done
wait
echo -e "  ${GREEN}✓ все 5 запросов завершены${RESET}"
echo ""

# ── 4. Rate limit ─────────────────────────────────────────────────────────────
echo -e "${BOLD}━━━ 4. Rate limit — 10 req/min, 11-й получает 429 ━━━${RESET}"
print_request "for i in {1..11}; do curl -X POST $BASE_URL/v1/chat/completions ... ; done"
for i in {1..11}; do
  CODE=$(curl -s -o /dev/null -w "%{http_code}" -X POST "$BASE_URL/v1/chat/completions" \
    -H "Authorization: Bearer $API_KEY" \
    -H "Content-Type: application/json" \
    -d '{"messages":[{"role":"user","content":"hi"}],"stream":false}')
  if [ "$CODE" = "429" ]; then
    echo -e "  req $i: ${RED}$CODE — Too Many Requests ← rate limit сработал${RESET}"
  else
    echo -e "  req $i: ${GREEN}$CODE${RESET}"
  fi
done
echo ""

# ── 5. Max context ────────────────────────────────────────────────────────────
echo -e "${BOLD}━━━ 5. Max context — 9000 символов, лимит 8000 ━━━${RESET}"
print_request "curl -X POST $BASE_URL/v1/chat/completions \\
  -d '{\"messages\":[{\"role\":\"user\",\"content\":\"<9000 символов>\"}]}'"
BIG=$(python3 -c "print('x'*9000)")
BODY="{\"messages\":[{\"role\":\"user\",\"content\":\"$BIG\"}],\"stream\":false}"
curl -s -X POST "$BASE_URL/v1/chat/completions" \
  -H "Authorization: Bearer $API_KEY" \
  -H "Content-Type: application/json" \
  -d "$BODY" | python3 -m json.tool
echo ""

echo -e "${GREEN}${BOLD}✓ Демонстрация завершена${RESET}"
echo -e "  Чат в браузере: ${CYAN}open $BASE_URL/${RESET}"
echo ""
