# Демонстрация: MCP интеграция в CLI Agent

Этот сценарий показывает, как агент работает с файлами через локальный MCP сервер вместо встроенных инструментов.

---

## Что демонстрируется

- Запуск агента, который автоматически поднимает MCP файловый сервер (stdio)
- Работа со всеми файловыми операциями через MCP: чтение, запись, удаление, листинг, копирование, перемещение
- Отображение вызовов MCP инструментов в UI: `[MCP: files] read_file`
- Запрос подтверждения для деструктивных операций (`write_file`, `delete_file`, `move_file`)
- Sandbox защита: попытка выйти за пределы sandbox получает ошибку
- Конфигурация MCP серверов через `config.json`

---

## Шаг 1: Подготовка окружения

### Клонировать репозиторий и установить зависимости

```bash
git clone <repo-url>
cd cli-agent
npm install
```

### Настроить провайдер

Скопировать `.env.example` в `.env` и выбрать провайдер:

```bash
cp .env.example .env
```

**Вариант A — LM Studio (локальная модель):**
1. Запустить LM Studio
2. В разделе Server → Start Server (порт 1234)
3. Загрузить любую модель с поддержкой tool calling (например, Qwen2.5-7B-Instruct)
4. В `.env` оставить `LLM_PROVIDER=lmstudio`

**Вариант B — DeepSeek:**
```
LLM_PROVIDER=deepseek
DEEPSEEK_API_KEY=sk-...
```

### Убедиться что sandbox пуст (или создать его)

```bash
mkdir -p sandbox
ls sandbox/   # должно быть пусто
```

---

## Шаг 2: Запуск агента

```bash
npm start
```

При первом запуске агент покажет мастер настройки:

```
? Your name: demo
? Language: English
? Response style: concise
? Provider: lmstudio
```

После настройки появится выбор сессии:

```
? Session:
  ▶ New session
    2026-04-06_143021  "написать todo app"
```

Выбрать **New session**. Агент запустит MCP файловый сервер и зарегистрирует инструменты:

```
CLI Agent ready — user: demo, provider: lmstudio, model: local-model
Sandbox: sandbox/
Session: 2026-04-06_150000  |  Type your message. Ctrl+C to exit.

>
```

> **Что происходит за кулисами:** при старте `McpClient.initialize()` запускает
> `tsx mcp-servers/files/index.ts` как дочерний процесс, соединяется через stdio,
> вызывает `tools/list` и регистрирует 8 инструментов в ToolRegistry с префиксом `files__`.

---

## Шаг 3: Листинг файлов в sandbox

```
> покажи что есть в sandbox
```

Агент вызовет `files__list_directory` и в терминале появится:

```
⚙ [MCP: files] list_directory
{
  "path": "."
}
→ (empty)

Agent:
Sandbox directory is empty.
```

---

## Шаг 4: Создание структуры проекта

```
> создай структуру для небольшого todo приложения: папку todo/, файл todo/README.md с описанием, и todo/tasks.json с пустым массивом
```

Агент спланирует задачу, затем выполнит несколько шагов. При вызове `write_file` появится запрос подтверждения:

```
⚙ [MCP: files] create_directory
{
  "path": "todo"
}
→ Directory created: todo

⚙ [MCP: files] write_file
{
  "path": "todo/README.md",
  "content": "# Todo App\n\nSimple task tracker..."
}
? Allow write_file?
  ▶ Yes, allow
    No, skip
```

После подтверждения:

```
→ Written 42 bytes to todo/README.md

⚙ [MCP: files] write_file
{
  "path": "todo/tasks.json",
  "content": "[]"
}
? Allow write_file?
  ▶ Yes, allow
    No, skip
→ Written 2 bytes to todo/tasks.json
```

Проверяем результат:

```bash
# В отдельном терминале:
ls sandbox/todo/
# README.md  tasks.json
```

---

## Шаг 5: Чтение файла

```
> прочитай todo/tasks.json
```

```
⚙ [MCP: files] read_file
{
  "path": "todo/tasks.json"
}
→ []

Agent:
The file `tasks.json` is currently empty (contains an empty array `[]`).
```

Чтение не требует подтверждения.

---

## Шаг 6: Проверка существования файла

```
> проверь, существует ли файл todo/config.json
```

```
⚙ [MCP: files] file_exists
{
  "path": "todo/config.json"
}
→ not found: todo/config.json

Agent:
The file `todo/config.json` does not exist yet.
```

---

## Шаг 7: Копирование файла

```
> скопируй todo/tasks.json в todo/tasks.backup.json
```

```
⚙ [MCP: files] copy_file
{
  "src": "todo/tasks.json",
  "dest": "todo/tasks.backup.json"
}
→ Copied todo/tasks.json → todo/tasks.backup.json
```

Копирование не деструктивное — подтверждение не требуется.

---

## Шаг 8: Перемещение файла (с подтверждением)

```
> переименуй todo/README.md в todo/OVERVIEW.md
```

```
⚙ [MCP: files] move_file
{
  "src": "todo/README.md",
  "dest": "todo/OVERVIEW.md"
}
? Allow move_file?
  ▶ Yes, allow
    No, skip
→ Moved todo/README.md → OVERVIEW.md
```

---

## Шаг 9: Удаление файла (с подтверждением)

```
> удали todo/tasks.backup.json
```

```
⚙ [MCP: files] delete_file
{
  "path": "todo/tasks.backup.json"
}
? Allow delete_file?
  ▶ Yes, allow
    No, skip
→ Deleted todo/tasks.backup.json
```

---

## Шаг 10: Sandbox защита

```
> прочитай файл ../package.json
```

MCP сервер проверяет путь и отклоняет:

```
⚙ [MCP: files] read_file
{
  "path": "../package.json"
}
→ Error: Path escapes sandbox: "../package.json" (sandbox: /path/to/cli-agent/sandbox)

Agent:
I cannot read that file — it is outside the sandbox directory.
```

---

## Шаг 11: Просмотр итоговой структуры

```
> покажи всё что сейчас в sandbox
```

```
⚙ [MCP: files] list_directory
{
  "path": "."
}
→ [dir]  todo

⚙ [MCP: files] list_directory
{
  "path": "todo"
}
→ [file] OVERVIEW.md
  [file] tasks.json
```

---

## Шаг 12: Выход

```
> /exit
Goodbye!
```

MCP клиент закрывает соединение, дочерний процесс завершается.

---

## Конфигурация MCP серверов

Список серверов хранится в `data/users/<name>/config.json`:

```json
{
  "mcpServers": {
    "files": "tsx mcp-servers/files/index.ts"
  }
}
```

Чтобы подключить дополнительный MCP сервер — добавить новую запись:

```json
{
  "mcpServers": {
    "files": "tsx mcp-servers/files/index.ts",
    "database": "node /path/to/db-mcp-server.js"
  }
}
```

Его инструменты автоматически появятся в агенте с префиксом `database__`.

---

## Краткая справка по инструментам

| Инструмент | Описание | Подтверждение |
|---|---|---|
| `[MCP: files] read_file` | Читает файл | Нет |
| `[MCP: files] write_file` | Записывает файл | **Да** |
| `[MCP: files] delete_file` | Удаляет файл | **Да** |
| `[MCP: files] list_directory` | Листинг директории | Нет |
| `[MCP: files] create_directory` | Создаёт директорию | Нет |
| `[MCP: files] move_file` | Перемещает/переименовывает | **Да** |
| `[MCP: files] file_exists` | Проверяет существование | Нет |
| `[MCP: files] copy_file` | Копирует файл | Нет |
