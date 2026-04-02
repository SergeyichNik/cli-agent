# CLI Code Assistant Agent — TODO & Planning

## Собранные требования

| Параметр | Решение |
|---|---|
| Runtime | Node.js + TypeScript |
| LLM providers | DeepSeek API, LM Studio (local OpenAI-compatible) |
| Идентификация пользователя | `--user <name>` флаг, config per user |
| Хранилище LTM | SQLite (better-sqlite3) |
| Оптимизация контекста | Sticky-facts + Summarization |
| Task input | Пользователь пишет в CLI, агент определяет стадию |
| Tools архитектура | Plugin-style, минимальный core |
| Output | Streaming (токены в реальном времени) |
| UI | Markdown в терминале (marked-terminal или cli-highlight, без ink) |
| Deploy | Локально, с заделом на расширение |

---

## Структура проекта

```
cli-agent/
├── src/
│   ├── cli/                  # Entry point, arg parsing
│   │   ├── index.ts
│   │   └── args.ts
│   ├── core/
│   │   ├── agent.ts          # Главный loop агента
│   │   ├── task-state.ts     # State machine
│   │   └── invariants.ts     # Invariant checker
│   ├── memory/
│   │   ├── ltm.ts            # Long-Term Memory (SQLite)
│   │   ├── wm.ts             # Working Memory (in-process)
│   │   └── sm.ts             # Session Memory (runtime)
│   ├── context/
│   │   ├── optimizer.ts      # Sticky-facts + summarization
│   │   ├── summarizer.ts     # LLM-based summarization
│   │   └── sticky.ts         # Sticky facts extractor
│   ├── providers/
│   │   ├── base.ts           # Abstract LLMProvider interface
│   │   ├── deepseek.ts       # DeepSeek provider
│   │   └── lmstudio.ts       # LM Studio (OpenAI-compat)
│   ├── tools/
│   │   ├── registry.ts       # Plugin registry
│   │   ├── base.ts           # Tool interface
│   │   └── builtin/
│   │       ├── read-file.ts
│   │       ├── write-file.ts
│   │       └── shell.ts
│   ├── user/
│   │   ├── profile.ts        # User config manager
│   │   └── auth.ts           # First-run setup
│   └── ui/
│       ├── renderer.ts       # Markdown rendering (marked-terminal)
│       └── stream.ts         # Streaming output handler
├── data/
│   └── users/                # Per-user data (gitignored)
│       └── <username>/
│           ├── config.json
│           ├── ltm.db
│           └── sessions/
├── plugins/                  # External tool plugins
├── package.json
├── tsconfig.json
└── README.md
```

---

## TODO

### PHASE 1 — Scaffolding & Core Infrastructure

- [ ] **P1-01** Инициализация проекта
    - `npm init`, `tsconfig.json` (strict mode, ESM или CJS — определиться)
    - Зависимости: `typescript`, `tsx`, `@types/node`
    - Dev: `eslint`, `prettier`

- [ ] **P1-02** CLI entry point (`src/cli/index.ts`)
    - Парсинг аргументов: `--user <name>`, `--provider <deepseek|lmstudio>`, `--model <name>`
    - Флаг `--help`, `--version`
    - Библиотека: `minimist` или `commander` (легковесные, без проблем)

- [ ] **P1-03** User profile system (`src/user/`)
    - При `--user <name>`: проверить наличие `data/users/<name>/config.json`
    - Если новый пользователь — запустить интерактивный first-run wizard:
        - Имя/алиас, предпочитаемый язык ответов, стиль (краткий / подробный)
        - Предпочитаемый provider и модель
    - Сохранить config, создать структуру директорий

- [ ] **P1-04** LLM Provider abstraction (`src/providers/`)
    - Интерфейс `LLMProvider`: `stream(messages, options): AsyncIterable<string>`
    - `DeepSeekProvider` — через официальный REST API (OpenAI-compatible)
    - `LMStudioProvider` — OpenAI-compatible endpoint (`http://localhost:1234/v1`)
    - Retry logic, timeout handling, error normalization

- [ ] **P1-05** Streaming UI (`src/ui/`)
    - `StreamRenderer` — принимает `AsyncIterable<string>`, пишет в stdout
    - Markdown рендеринг финального ответа: `marked` + `marked-terminal`
    - Индикатор загрузки (простой спиннер через `process.stdout.write` без ink)

---

### PHASE 2 — Memory System

- [ ] **P2-01** Session Memory — SM (`src/memory/sm.ts`)
    - In-memory хранилище текущей сессии
    - Хранит: raw messages[], текущий task, активные инварианты
    - Очищается при завершении процесса

- [ ] **P2-02** Working Memory — WM (`src/memory/wm.ts`)
    - Скользящее окно активного контекста (последние N токенов/сообщений)
    - Интерфейс: `add(message)`, `getWindow(): Message[]`, `tokenCount(): number`
    - Настраиваемый лимит токенов из user config

- [ ] **P2-03** Long-Term Memory — LTM (`src/memory/ltm.ts`)
    - SQLite через `better-sqlite3`
    - Таблицы:
        - `facts` — sticky facts (key, value, created_at, updated_at, relevance_score)
        - `summaries` — сжатые резюме прошлых сессий (session_id, summary, timestamp)
        - `sessions` — метаданные сессий
    - API: `saveFact()`, `getFacts()`, `saveSessionSummary()`, `searchRelevant(query)`
    - Per-user: путь `data/users/<name>/ltm.db`

---

### PHASE 3 — Context Optimization

- [ ] **P3-01** Sticky Facts extractor (`src/context/sticky.ts`)
    - После каждого ответа агента — LLM-вызов для извлечения фактов о пользователе
    - Промпт: "Extract persistent facts about the user/project from this conversation"
    - Дедупликация и обновление существующих фактов в LTM
    - Факты всегда инжектируются в system prompt (отсюда — "sticky")

- [ ] **P3-02** Summarizer (`src/context/summarizer.ts`)
    - Триггер: когда WM превышает 80% лимита токенов
    - LLM-вызов: сжать самую старую часть WM в 3-5 предложений
    - Сохранить summary в LTM, удалить сжатые сообщения из WM

- [ ] **P3-03** Context Optimizer оркестратор (`src/context/optimizer.ts`)
    - Собирает финальный контекст для LLM запроса:
        1. System prompt (base + user persona + sticky facts из LTM)
        2. Relevant summaries из LTM (если есть релевантные прошлые сессии)
        3. WM (sliding window активного диалога)
    - Метод `buildContext(userMessage): Message[]`

---

### PHASE 4 — Task State Machine

- [ ] **P4-01** Определение состояний (`src/core/task-state.ts`)
  ```
  States: IDLE → PLANNING → EXECUTING → PAUSED → VALIDATION → DONE → ERROR
  ```
    - Transitions:
        - `IDLE` → `PLANNING`: пользователь описал задачу
        - `PLANNING` → `EXECUTING`: план подтверждён / агент готов к действию
        - `EXECUTING` → `PAUSED`: пользователь написал "стоп/pause/подожди"
        - `PAUSED` → `EXECUTING`: пользователь написал "продолжай/resume"
        - `EXECUTING` → `VALIDATION`: агент завершил шаги, просит проверить
        - `VALIDATION` → `DONE`: пользователь подтвердил
        - `VALIDATION` → `EXECUTING`: найдены проблемы, возвращаемся
        - Любое → `ERROR`: критическая ошибка

- [ ] **P4-02** Intent classifier
    - LLM-вызов (малая модель / быстрый промпт) для определения intent пользователя
    - Определяет: это новая задача? уточнение? пауза? подтверждение? вопрос?
    - На основе intent — решение о переходе состояния

- [ ] **P4-03** Task persistence
    - Текущий task сохраняется в SM, при завершении — в LTM
    - При старте сессии — показать незавершённые tasks (если есть)
    - Поддержка `--resume <session_id>` флага

---

### PHASE 5 — Invariants System

- [ ] **P5-01** Invariant engine (`src/core/invariants.ts`)
    - Инварианты — это правила/ограничения, которые агент должен соблюдать всегда
    - Виды инвариантов:
        - **Safety**: не удалять файлы без подтверждения, не запускать destructive команды
        - **Style**: всегда отвечать на языке пользователя, соблюдать code style
        - **Scope**: не выходить за пределы рабочей директории без явного разрешения
        - **Custom**: пользователь может добавлять свои через config

- [ ] **P5-02** Invariant validation pipeline
    - Перед каждым tool call — проверка инвариантов
    - Перед отправкой ответа — проверка invariants на output
    - При нарушении: прервать действие, объяснить пользователю, запросить разрешение

- [ ] **P5-03** User-configurable invariants
    - В `config.json` пользователя: `invariants: []` — список правил в natural language
    - Инжектируются в system prompt
    - Пример: `"Always suggest tests when writing new functions"`

---

### PHASE 6 — Tool Plugin System

- [ ] **P6-01** Tool interface & registry (`src/tools/`)
    - Интерфейс `Tool`: `name`, `description`, `parameters` (JSON Schema), `execute(params)`
    - `ToolRegistry`: регистрация, lookup по имени, список для LLM (tool_calls формат)
    - Проверка инвариантов перед `execute()`

- [ ] **P6-02** Builtin tools (минимальный core)
    - `read_file(path)` — чтение файла
    - `write_file(path, content)` — запись (с invariant проверкой)
    - `shell(command)` — выполнение shell команды (с whitelist/blacklist)
    - `list_dir(path)` — список файлов

- [ ] **P6-03** Plugin loader
    - Загрузка внешних плагинов из `plugins/` директории
    - Каждый плагин — отдельный `.ts`/`.js` файл, экспортирующий `Tool[]`
    - Hot-reload не нужен, загрузка при старте агента

---

### PHASE 7 — Agent Core Loop

- [ ] **P7-01** Main agent loop (`src/core/agent.ts`)
  ```
  loop:
    1. Получить input от пользователя
    2. Classify intent → обновить task state
    3. Проверить инварианты на input
    4. Собрать контекст (ContextOptimizer)
    5. Стриминг LLM запрос
    6. Если tool_call → проверить инварианты → execute → вернуть результат в контекст
    7. Рендерить финальный ответ (Markdown)
    8. Обновить WM, извлечь sticky facts, обновить LTM
    9. Если task state == DONE → сохранить session summary
  ```

- [ ] **P7-02** Multi-turn tool execution
    - Поддержка цепочки tool calls (агент вызывает несколько tools за один turn)
    - Лимит глубины рекурсии (настраиваемый, default: 10 шагов)
    - Показывать пользователю что делает агент в реальном времени

- [ ] **P7-03** Error recovery
    - При ошибке tool call — агент получает error message и пытается исправиться
    - После N неудачных попыток — переход в `ERROR` state, объяснение пользователю

---

### PHASE 8 — Polish & DX

- [ ] **P8-01** Configuration system
    - Global config: `~/.config/cli-agent/config.json`
    - Per-user: `data/users/<name>/config.json`
    - Параметры: provider, model, context window size, language, style, invariants

- [ ] **P8-02** Logging
    - Debug логи в файл `data/users/<name>/sessions/<session_id>.log`
    - Флаг `--debug` для verbose stdout вывода
    - Структурированный JSON лог для будущего анализа

- [ ] **P8-03** README и документация
    - Установка, быстрый старт
    - Описание флагов CLI
    - Как писать плагины (Tool interface)
    - Описание системы инвариантов

---

## Зависимости (предварительный список)

```json
{
  "dependencies": {
    "commander": "^12.x",
    "better-sqlite3": "^9.x",
    "marked": "^12.x",
    "marked-terminal": "^7.x",
    "openai": "^4.x"
  },
  "devDependencies": {
    "typescript": "^5.x",
    "tsx": "^4.x",
    "@types/node": "^20.x",
    "@types/better-sqlite3": "^7.x"
  }
}
```

> `openai` SDK используется для обоих провайдеров — DeepSeek и LM Studio оба совместимы с OpenAI API format.

---

## Порядок реализации (рекомендуемый)

```
P1 (scaffolding) → P2 (memory) → P4 (state machine) → P3 (context) → P5 (invariants) → P6 (tools) → P7 (agent loop) → P8 (polish)
```

Минимально рабочий агент: **P1 + P2-01/02 + P4-01 + P7-01** (без LTM, без tools, без invariants).
