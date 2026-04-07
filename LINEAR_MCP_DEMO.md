# Linear MCP — Demo Scenario

Демонстрация того как агент автономно управляет задачами в Linear через MCP инструменты.

---

## Настройка

```bash
# 1. Добавить ключ в .env
LINEAR_API_KEY=lin_api_xxxxxxxxxxxxxxxx

# 2. Запустить агента
npm start
```

Проверить что инструменты подключились:
```
/mcp linear
```

Ожидаемый вывод:
```
[MCP: linear]  tsx mcp-servers/linear/index.ts
  list_teams      — список команд с их UUID
  list_issues     — список задач с фильтрами
  create_issue    — создать задачу
  update_issue    — обновить задачу
```

---

## Сценарий 1 — Планирование MVP

**Запрос:**
```
запланируй задачи в linear для mvp todo web app
```

**Что делает агент:**
1. В фазе planning уточняет функциональность и стек
2. В фазе execution:
   - Вызывает `linear__list_teams` → получает UUID команды
   - Вызывает `linear__create_issue` для каждой задачи MVP:
     - "Setup project structure (HTML/CSS/JS)"
     - "Implement task list UI"
     - "Add/delete task logic"
     - "Mark task as complete"
     - "Persist tasks in localStorage"

**Результат:** 5 задач созданы в Linear с приоритетами и описаниями, агент возвращает ссылки.

---

## Сценарий 2 — Просмотр бэклога

**Запрос:**
```
покажи все открытые задачи в linear
```

**Что делает агент:**
- Вызывает `linear__list_issues` с фильтром `status: "Todo"`
- Выводит структурированный список с приоритетами и ссылками

---

## Сценарий 3 — Обновление статуса

**Запрос:**
```
отметь задачу CLI-5 как in progress
```

**Что делает агент:**
- Вызывает `linear__update_issue` с `issueId: "CLI-5"` и новым `stateId`
- Подтверждает изменение со ссылкой на задачу

---

## Как это работает

```
.env (LINEAR_API_KEY)
        ↓
src/cli/index.ts          — авторегистрация linear в mcpServers при старте
        ↓
src/mcp/client.ts         — запуск MCP сервера как subprocess, листинг инструментов
        ↓
mcp-servers/linear/       — MCP сервер, 4 инструмента → Linear GraphQL API
        ↓
src/context/optimizer.ts  — системный промпт: два сценария (только MCP vs смешанный план)
        ↓
src/core/agent.ts         — агент вызывает инструменты автономно в фазе execution
```

### Два сценария в системном промпте

Агент различает два режима:

**Сценарий A** — пользователь просит взаимодействовать с внешним сервисом:
> "запланируй задачи в linear", "покажи мой бэклог"
→ Весь план состоит только из вызовов MCP инструментов. Локальные файлы не создаются.

**Сценарий Б** — пользователь просит построить что-то и отслеживать в сервисе:
> "собери todo app и создай linear задачи для отслеживания"
→ План смешанный: локальные шаги + MCP шаги.

---

## Файлы

| Файл | Роль |
|------|------|
| `mcp-servers/linear/index.ts` | MCP сервер — 4 инструмента поверх Linear GraphQL API |
| `mcp-servers/linear/package.json` | ESM пакет |
| `src/mcp/client.ts` | Запускает MCP серверы, оборачивает инструменты для агента |
| `src/cli/index.ts` | Авторегистрация linear если `LINEAR_API_KEY` задан |
| `src/context/optimizer.ts` | Инструкции агенту про MCP интеграции в системном промпте |
