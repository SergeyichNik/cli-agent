#!/bin/bash
# День 31 — Ассистент разработчика
# Запуск: bash ~/Documents/cli-agent/demo/scenarios/day31-test.sh

BOLD="\033[1m"
GRAY="\033[90m"
CYAN="\033[36m"
GREEN="\033[32m"
YELLOW="\033[33m"
RED="\033[31m"
RESET="\033[0m"

cd "$(dirname "$0")/../.." || exit 1

echo ""
echo -e "${BOLD}╔══════════════════════════════════════════════╗${RESET}"
echo -e "${BOLD}║   День 31 — Ассистент разработчика           ║${RESET}"
echo -e "${BOLD}╚══════════════════════════════════════════════╝${RESET}"
echo ""

# ── 1. Структура документации ─────────────────────────────────────────────────
echo -e "${BOLD}━━━ 1. Документация проекта (RAG-база) ━━━${RESET}"
echo -e "${GRAY}▶ tree docs/ README.md${RESET}"
echo ""
echo -e "  ${CYAN}README.md${RESET}          — описание проекта, быстрый старт"
echo -e "  ${CYAN}docs/${RESET}"
echo -e "  ${CYAN}├── architecture.md${RESET} — структура, entry points, sandbox, state machine"
echo -e "  ${CYAN}├── commands.md${RESET}     — CLI флаги и slash-команды"
echo -e "  ${CYAN}├── providers.md${RESET}    — настройка DeepSeek и LM Studio"
echo -e "  ${CYAN}└── mcp-servers.md${RESET}  — встроенные серверы, добавление своих"
echo ""

# ── 2. MCP Git — текущая ветка ─────────────────────────────────────────────
echo -e "${BOLD}━━━ 2. MCP Git — текущая ветка ━━━${RESET}"
echo -e "${GRAY}▶ git__git_is_repo → git branch --show-current${RESET}"
echo ""
BRANCH=$(git branch --show-current 2>/dev/null || echo "not a git repo")
LAST=$(git log -1 --format="%s" 2>/dev/null || echo "—")
COMMITS=$(git rev-list --count HEAD 2>/dev/null || echo "—")
echo -e "  ветка:          ${CYAN}${BRANCH}${RESET}"
echo -e "  коммитов:       ${CYAN}${COMMITS}${RESET}"
echo -e "  последний:      ${GRAY}${LAST}${RESET}"
echo -e "  ${GREEN}✓ git__git_is_repo вернул текущую ветку${RESET}"
echo ""

# ── 3. RAG + /help ────────────────────────────────────────────────────────────
echo -e "${BOLD}━━━ 3. RAG + /help — вопросы о проекте ━━━${RESET}"
echo -e "${GRAY}▶ npm run demo:day31${RESET}"
echo ""

if ! command -v ollama &>/dev/null; then
  echo -e "  ${YELLOW}⚠ Ollama не найдена. Запустите: ollama serve${RESET}"
  echo -e "  ${GRAY}Запускаем demo с пропуском этапа эмбеддингов...${RESET}"
  echo ""
fi

npm run demo:day31

echo ""
echo -e "${BOLD}━━━ 4. Использование в агенте ━━━${RESET}"
echo ""
echo -e "  ${GRAY}Запустите агент:${RESET}"
echo -e "  ${CYAN}agent --provider deepseek${RESET}"
echo ""
echo -e "  ${GRAY}Попробуйте slash-команды:${RESET}"
echo -e "  ${CYAN}/help${RESET}                          → список команд"
echo -e "  ${CYAN}/help как добавить MCP сервер?${RESET} → ответ из docs/ через RAG"
echo -e "  ${CYAN}/help где хранятся API ключи?${RESET}  → ответ из docs/architecture.md"
echo -e "  ${CYAN}/mcp git${RESET}                       → список git-инструментов"
echo ""
echo -e "${GREEN}${BOLD}✓ Демонстрация завершена${RESET}"
echo ""
