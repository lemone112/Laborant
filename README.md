# Laborant

> AI Code Review — Temporal + tree-sitter + MCP

Laborant — pipeline для ревью Merge Requests в GitLab. Оркестрация через Temporal, структурный анализ через tree-sitter, векторный поиск через Qdrant (опционально), граф зависимостей через Neo4j (опционально). MCP-сервер для интеграции с AI-агентами.

## Architecture

```
Context Assembly → [Triple Review?] → Consensus → [CoVe?] → Report
      ↓                ↓              ↓          ↓         ↓
  Landscape      Logic/Risk/    Aggregate    Verify    GitLab
  + Risk Map     Consistency    findings     escalated  inline
  + Patterns     (parallel)                  only       comments
```

**Что обязательно:** LLM API (OpenAI-совместимый). Всё остальное — опционально и gracefully деградирует.

### Execution Modes

1. **Temporal Workflow** (`reviewWorkflow`) — production mode with durability, retries, observability
2. **Direct Pipeline** (`runReviewPipeline`) — for MCP server, CLI, local dev

Both modes share the same pipeline logic. The Temporal workflow passes configuration (budget, feature flags) as input parameters, making it fully deterministic and configurable without env access.

### LLM Orchestration

LLM calls use plain async functions inside Temporal Activities. No LangGraph — the pipeline is linear enough that a simple Activity-per-step pattern is sufficient and more maintainable. If conditional branching becomes complex, LangGraph can be nested inside Activities later.

## Model Tiers

Все модели — алиасы через ENV. Ноль хардкода.

| Tier | ENV Variable | Use Case |
|------|-------------|----------|
| Cheap | `LLM_CHEAP_MODEL` | Landscape scan |
| Base | `LLM_BASE_MODEL` | Risk map, consistency review, CoVe verify, report |
| Frontier | `LLM_FRONTIER_MODEL` | Logic/risk review, consensus |
| Embedding | `LLM_EMBEDDING_MODEL` | Code vectorization |

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/lemone112/Laborant.git
cd Laborant
cp .env.example .env
# Edit .env — only LLM_* vars are required

# 2. Install dependencies
npm install

# 3. Build
npm run build

# 4. Run API server
npm start

# 5. Run Temporal worker (separate process)
npm run worker

# 6. Run MCP server (separate process)
npm run mcp
```

## ENV Configuration

Only **LLM_*** variables are required. Infrastructure deps are optional:

| Variable | Required | Default | Notes |
|----------|----------|---------|-------|
| `LLM_BASE_URL` | ✅ | — | OpenAI-compatible API |
| `LLM_API_KEY` | ✅ | — | API key |
| `LLM_CHEAP_MODEL` | ✅ | — | e.g. `gpt-4o-mini` |
| `LLM_BASE_MODEL` | ✅ | — | e.g. `gpt-4o` |
| `LLM_FRONTIER_MODEL` | ✅ | — | e.g. `o3` |
| `LLM_EMBEDDING_MODEL` | ✅ | — | e.g. `text-embedding-3-small` |
| `NEO4J_URL` | ❌ | `bolt://localhost:7687` | Fallback: LLM-based risk map |
| `QDRANT_URL` | ❌ | `http://localhost:6333` | Fallback: skip similar patterns |
| `DATABASE_URL` | ❌ | `postgresql://localhost/...` | Feedback tracking |
| `GITLAB_URL` | ❌ | `https://gitlab.com` | GitLab integration |
| `TEMPORAL_URL` | ❌ | `localhost:7233` | Temporal server |
| `PIPELINE_MAX_LLM_CALLS` | ❌ | `25` | Budget per review |
| `PIPELINE_MAX_COST_USD` | ❌ | `0.50` | Max cost per review |
| `PIPELINE_COVE_ENABLED` | ❌ | `true` | CoVe verification |
| `PIPELINE_TRIPLE_REVIEW` | ❌ | `true` | Triple review (disable for fast mode) |
| `REVIEW_LANGUAGE` | ❌ | `en` | Review output language (`en`/`ru`) |

## Pipeline Steps

1. **Context Assembly** — landscape scan + risk map (Neo4j or LLM fallback) + similar patterns (Qdrant)
2. **Triple Review** — 3 parallel reviewers: Logic, Risk, Consistency (budget split by 3 to prevent overspend)
3. **Feedback Gate** — adjusts findings based on historical false-positive patterns
4. **Consensus** — aggregates findings, generates stable IDs, marks escalated
5. **CoVe** — single-step verification for escalated findings only
6. **Report** — JSON with inline comments + summary for GitLab

## MCP Tools

| Tool | Description |
|------|-------------|
| `review_snippet` | Full review of code snippet |
| `check_risk` | Risk analysis for changed files |
| `find_patterns` | Semantic search for similar patterns |
| `explain_symbol` | Explain symbol in codebase context |
| `query_graph` | Read-only query of dependency graph (by symbol or file) |

## Security

- Webhook token validation uses `crypto.timingSafeEqual` (timing-attack resistant)
- MCP `query_graph` only allows parameterized read-only queries — no raw Cypher
- Budget split across parallel activities prevents 3× overspend
- All database queries use parameterized statements

## License

MIT
