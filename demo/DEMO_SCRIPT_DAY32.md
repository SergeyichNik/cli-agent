# Сценарий демонстрации — День 32: Автоматизация ревью кода

## Что показываем

Пайплайн AI-ревью PR: агент получает diff из GitHub, читает изменённые файлы,
генерирует структурированное ревью (баги / архитектура / рекомендации) и публикует
комментарий прямо в PR.

---

## Подготовка (до записи)

```bash
# 1. Убедиться что токены есть в secrets.json
cat ~/.config/agent/secrets.json
# Нужны: deepseek.apiKey, github.apiKey

# 2. Открыть PR в браузере — чтобы показать "до"
open https://github.com/SergeyichNik/cli-agent/pull/1

# 3. Убедиться что сборка актуальна
npm run build
```

---

## Сценарий (запись)

### Шаг 1 — Показать архитектуру пайплайна

Открыть `.github/workflows/pr-review.yml` и объяснить:

```yaml
on: [pull_request]   # → триггер на каждый PR
→ npm ci && npm run build
→ agent review-pr --repo ${{ github.repository }} --pr ${{ github.event.number }}
   ↑ два env: DEEPSEEK_API_KEY + GITHUB_TOKEN из secrets
```

> "Любой PR в репозитории автоматически получает AI-ревью.
> Агент не интерактивен — запускается как CLI-команда."

---

### Шаг 2 — Показать что PR пустой (нет комментариев)

Открыть `https://github.com/SergeyichNik/cli-agent/pull/1` в браузере.
Показать вкладку **Comments** — пусто или только старые комментарии.

---

### Шаг 3 — Запустить демо

```bash
npm run demo:day32 -- --repo SergeyichNik/cli-agent --pr 1
```

Объяснять по ходу каждый шаг:

| Шаг | Что происходит |
|-----|----------------|
| **0. Credentials** | Читает токены из `~/.config/agent/secrets.json` |
| **1. GitHub PR** | Определяем репо и номер PR |
| **2. Diff** | `GET /pulls/{pr}/` с `Accept: application/vnd.github.diff` → unified diff |
| **3. Файлы** | `GET /pulls/{pr}/files` → список с `+additions/-deletions` |
| **4. RAG** | Читает изменённые файлы локально — без embeddings, без Ollama |
| **5. DeepSeek** | Генерация ревью стримингом, токен за токеном |
| **6. Публикация** | `POST /issues/{pr}/comments` → комментарий в PR |

Акцентировать:

- **RAG без embeddings**: знаем какие файлы изменились → читаем их напрямую
- **Структура ревью**: три фиксированных секции, вердикт в заголовке
- **Стриминг**: ревью появляется постепенно — видно как модель "думает"

---

### Шаг 4 — Показать результат в GitHub

Обновить браузер на странице PR → новый комментарий от бота.

Показать структуру комментария:

```
## AI Code Review ⚠️ Есть замечания (2)

### 🐛 Потенциальные баги
### 🏗️ Архитектурные проблемы
### 💡 Рекомендации
```

> "Замечания реальные — модель нашла несоответствия в документации,
> удалённый тест-план без миграции, дрейф между `.env.example` и `CLAUDE.md`."

---

### Шаг 5 — Показать CLI-команду (ручной режим)

```bash
agent review-pr --repo SergeyichNik/cli-agent --pr 1
```

> "Та же команда, что запускает GitHub Action.
> Можно использовать локально без CI — например, перед пушем."

---

### Шаг 6 — Показать GitHub MCP в интерактивном агенте (опционально)

```bash
agent
```

В сессии:
```
> /mcp github
> Посмотри diff PR #1 в репозитории SergeyichNik/cli-agent
```

> "GitHub MCP зарегистрирован как встроенный сервер — агент может
> обращаться к GitHub в ходе любой сессии, не только при ревью."

---

## Ключевые тезисы

- **Пайплайн**: GitHub Action → `agent review-pr` → diff + файлы → DeepSeek → комментарий
- **RAG**: читаем файлы по известному списку (не semantic search) → работает в CI без Ollama
- **Два режима**: автоматический (GitHub Action) + ручной (`agent review-pr` / `/mcp github`)
- **Расширяемость**: добавить новый репо → один секрет `DEEPSEEK_API_KEY` + скопировать workflow

---

## Команды шпаргалка

```bash
# Демо-скрипт
npm run demo:day32 -- --repo SergeyichNik/cli-agent --pr 1

# CLI-команда (после npm link)
agent review-pr --repo SergeyichNik/cli-agent --pr 1

# Список изменений Day 32
git show --stat HEAD
```
