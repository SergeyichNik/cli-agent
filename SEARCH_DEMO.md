# Demo: Document Indexing (Day 21)

## Что реализовано

Встроенный MCP-сервер `search` — локальный RAG-пайплайн поверх CLI-агента:

- **Chunking A:** фиксированный размер — 512 токенов, overlap 50 (via tiktoken cl100k)
- **Chunking B:** структурный — по заголовкам Markdown / top-level экспортам TypeScript
- **Embeddings:** `nomic-embed-text` через Ollama (локально, офлайн)
- **Хранилище:** SQLite (`.agent/data/search.db`) — чанки + метаданные + эмбеддинги (BLOB)
- **Поиск:** cosine similarity в JS, top-K результатов

---

## Сценарий демонстрации

### Шаг 1 — Индексация с обеими стратегиями

```
> проиндексируй все .ts файлы проекта, стратегия both
```

Агент вызывает `search__index_documents(glob: "**/*.ts", strategy: "both")`.

Ожидаемый вывод — сравнение стратегий:

```
Indexed 24 files with both strategies.

Strategy comparison:
  Fixed:         247 chunks | avg  489 tokens | min  38 | max 512
  Structural:    134 chunks | avg  901 tokens | min  12 | max 4672
```

**Вывод:** фиксированная стратегия создаёт больше мелких чанков — выше точность поиска.
Структурная — сохраняет логические единицы кода целиком, лучше для понимания контекста.

---

### Шаг 2 — Статус индекса

```
> покажи статус индекса
```

Агент вызывает `search__index_status()`. Показывает: кол-во чанков по стратегиям, топ файлов, время последней индексации.

---

### Шаг 3 — Семантический поиск

```
> как регистрируются MCP-серверы?
```

Агент вызывает `search__search(query: "как регистрируются MCP серверы", topK: 5)`.

Ожидаемый результат — релевантные чанки из `src/cli/index.ts` и `src/mcp/client.ts` с оценкой сходства.

---

### Шаг 4 — Поиск с фильтром по стратегии

```
> найди код обработки ошибок, только структурные чанки
```

Агент вызывает `search__search(query: "error handling", strategy: "structural", topK: 5)`.

---

### Шаг 5 — Индексация Markdown

```
> проиндексируй README и CLAUDE.md
```

```
search__index_documents(glob: "**/*.md", strategy: "both")
```

Структурный chunking разбивает по заголовкам `#` / `##`.
Фиксированный — по токенам без учёта структуры.

---

### Шаг 6 — Переиндексация после изменений

```
> переиндексируй все файлы
```

Агент вызывает `search__reindex()` — удаляет старые чанки, запускает заново.

---

## Архитектура

```
mcp-servers/search/
  index.ts       ← MCP-сервер: 4 инструмента
  chunker.ts     ← стратегии A (fixed) и B (structural)
  embeddings.ts  ← EmbeddingProvider + OllamaProvider + OpenAICompatibleProvider
  db.ts          ← SQLite: схема, insert, cosine search
```

Смена провайдера эмбеддингов — через `.agent/config.json`:

```json
{
  "embeddingProvider": {
    "type": "openai-compatible",
    "model": "text-embedding-ada-002",
    "url": "http://localhost:1234",
    "apiKey": ""
  }
}
```
