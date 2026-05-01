# LongTermMemory — карта использований

## Что такое LongTermMemory

`LongTermMemory` — это класс долговременного хранения данных агента, реализованный на SQLite (через `better-sqlite3`). Он находится в `src/memory/ltm.ts` и управляет четырьмя сущностями:

| Сущность | Таблица SQLite | Назначение |
|-----------|----------------|------------|
| **Facts** | `facts` + FTS5 | Ключ-значение фактов о пользователе/проекте (scope: сессия) |
| **Summaries** | `summaries` + FTS5 | Сжатые саммари диалогов (для контекстного окна) |
| **Sessions** | `sessions` | Метаданные сессий (id, user, даты, task, инварианты, % контекста) |
| **Task state** | `sessions.task_json` | JSON-сериализованное состояние задачи (план, шаги, прогресс) |

---

## Таблица использований

| Файл | Строки | Роль / что делает |
|------|--------|-------------------|
| `src/memory/ltm.ts` | 31–295 | **Определение класса.** Конструктор принимает путь к `.db` файлу, создаёт/мигрирует схему. Методы: `saveFact`, `getFactsBySession`, `saveSessionSummary`, `getSessionSummaries`, `searchRelevant` (FTS5), `saveSession`, `endSession`, `updateSessionTitle`, `updateSessionCtxPct`, `getSessionList`, `getSession`, `deleteSession`, `saveSessionInvariant`, `getSessionInvariants`, `saveTaskState`, `getTaskState`, `close`. |
| `src/cli/index.ts` | 23 (import), 150 (new), 170–180 (resume), 215–220 (/facts), 240–260 (/invariants), 330 (endSession), 350 (close) | **Точка входа (CLI).** Создаёт единственный экземпляр `LongTermMemory` при старте. Использует его для: выбора/возобновления сессии, чтения фактов (`/facts`), чтения/записи инвариантов (`/invariants`, `/invariant`), завершения сессии, сохранения состояния задачи после каждого turn. |
| `src/cli/session-picker.ts` | 3 (import type), 52 (параметр), 57 (getSessionList), 80 (getTaskState), 93 (deleteSession) | **Интерактивный выбор сессии.** Получает список сессий через `ltm.getSessionList()`, показывает их пользователю. При выборе существующей — читает состояние задачи через `ltm.getTaskState()`. При удалении — вызывает `ltm.deleteSession()`. |
| `src/context/optimizer.ts` | 3 (import type), 102 (buildSystemPrompt), 203 (buildContext) | **Сборка системного промпта и контекста.** `buildSystemPrompt()`: читает факты сессии (`getFactsBySession`) и инварианты (`getSessionInvariants`) — встраивает их в промпт. `buildContext()`: ищет релевантные саммари прошлых сессий (`searchRelevant`) и добавляет их в контекст. |
| `src/context/sticky.ts` | 2 (import type), 7 (параметр), 22 (saveFact) | **Фоновое извлечение фактов.** Асинхронно (fire-and-forget) отправляет последние 10 сообщений LLM, которая извлекает факты в формате `{key, value}`. Каждый факт сохраняется через `ltm.saveFact()`. |
| `src/context/summarizer.ts` | 3 (import type), 8 (параметр), 25 (saveSessionSummary) | **Автосуммаризация при переполнении WM.** Когда `WorkingMemory` заполнен, вытесняет старейшую половину, отправляет её LLM для саммари и сохраняет результат через `ltm.saveSessionSummary()`. |
| `src/core/agent.ts` | 3 (import type), 19 (поле в AgentDeps), 39 (buildSystemPrompt), 40 (buildContext), 49 (saveSession), 50 (updateSessionTitle), 168 (saveTaskState), 196 (endSession), 201 (updateSessionCtxPct), 206 (extractAndSaveFactsAsync), 209 (summarizeIfNeeded) | **Основной цикл агента (`runAgentTurn`).** Координирует всё: при старте сессии сохраняет её (`saveSession`), после каждого turn сохраняет состояние задачи (`saveTaskState`), обновляет процент контекста (`updateSessionCtxPct`), при завершении — закрывает сессию (`endSession`). Запускает фоновое извлечение фактов и суммаризацию. |

---

## Итоговый вывод

### Где хранится состояние

Всё состояние хранится в **одном SQLite-файле** — `{dataDir}/ltm.db`. Файл создаётся в `src/cli/index.ts:148` (`ltmPath = path.join(dataDir, 'ltm.db')`). База данных использует WAL-режим для производительности.

Внутри БД:
- **`facts`** — ключ-значение с составным PK `(key, session_id)`. FTS5-индекс для полнотекстового поиска.
- **`summaries`** — саммари диалогов. FTS5-индекс для поиска релевантных прошлых сессий.
- **`sessions`** — метаданные сессий + JSON-поля `invariants`, `task_json`, `ctx_pct`.

### Кто пишет

| Что пишет | Кто | Когда |
|-----------|-----|-------|
| Факты (`saveFact`) | `src/context/sticky.ts` (фоновый extractor) | После каждого turn агента |
| Саммари (`saveSessionSummary`) | `src/context/summarizer.ts` | Когда WorkingMemory переполняется |
| Сессия (`saveSession`) | `src/core/agent.ts` (через `runAgentTurn`) | При первом сообщении в новой сессии |
| Заголовок сессии (`updateSessionTitle`) | `src/core/agent.ts` | При первом сообщении |
| Состояние задачи (`saveTaskState`) | `src/core/agent.ts` | После каждого turn (при изменении) |
| Процент контекста (`updateSessionCtxPct`) | `src/core/agent.ts` | После каждого turn |
| Завершение сессии (`endSession`) | `src/core/agent.ts` | Когда задача переходит в `done` или `error` |
| Инварианты (`saveSessionInvariant`) | `src/cli/index.ts` (команда `/invariant`) | По запросу пользователя |
| Удаление сессии (`deleteSession`) | `src/cli/session-picker.ts` | По запросу пользователя |

### Кто читает

| Что читает | Кто | Когда |
|------------|-----|-------|
| Факты сессии (`getFactsBySession`) | `src/context/optimizer.ts` (buildSystemPrompt) | При каждой сборке системного промпта |
| Инварианты (`getSessionInvariants`) | `src/context/optimizer.ts` (buildSystemPrompt) | При каждой сборке системного промпта |
| Релевантные саммари (`searchRelevant`) | `src/context/optimizer.ts` (buildContext) | При каждой сборке контекста (по сообщению пользователя) |
| Список сессий (`getSessionList`) | `src/cli/session-picker.ts` | При старте (интерактивный выбор) |
| Состояние задачи (`getTaskState`) | `src/cli/session-picker.ts` | При возобновлении сессии |
| Саммари сессии (`getSessionSummaries`) | `src/cli/index.ts` | При возобновлении сессии (восстановление контекста) |
| Факты (`getFactsBySession`) | `src/cli/index.ts` (команда `/facts`) | По запросу пользователя |

### Схема потоков данных

```
Пользователь
    │
    ▼
src/cli/index.ts  ──создаёт──►  LongTermMemory (ltm.db)
    │                                │
    ├── session-picker.ts ──────────►│ getSessionList, getTaskState, deleteSession
    │                                │
    ▼                                │
src/core/agent.ts                    │
    │                                │
    ├── context/optimizer.ts ───────►│ getFactsBySession, getSessionInvariants, searchRelevant
    │                                │
    ├── context/sticky.ts ──────────►│ saveFact
    │                                │
    ├── context/summarizer.ts ──────►│ saveSessionSummary
    │                                │
    └── (прямые вызовы) ───────────►│ saveSession, saveTaskState, updateSessionCtxPct, endSession
```

### Ключевые особенности

1. **Один экземпляр на весь lifecycle** — LTM создаётся один раз в `main()` и передаётся через `AgentDeps`.
2. **FTS5 для поиска** — саммари и факты индексируются через FTS5, что позволяет искать релевантные прошлые сессии по тексту запроса пользователя.
3. **Миграции схемы** — класс сам обновляет схему БД при изменении структуры (добавление колонок `session_id`, `invariants`, `ctx_pct`, `task_json`).
4. **Session-scoped facts** — факты привязаны к сессии через составной ключ `(key, session_id)`, что позволяет изолировать данные между сессиями.
5. **Фоновые операции** — извлечение фактов (`sticky.ts`) и суммаризация (`summarizer.ts`) работают асинхронно, не блокируя основной цикл агента.
