# Laborant

> AI Code Review — Temporal + tree-sitter + MCP

Laborant — pipeline для ревью Merge Requests в GitLab. Оркестрация через Temporal, структурный анализ через tree-sitter, векторный поиск через Qdrant (опционально), граф зависимостей через Neo4j (опционально). MCP-сервер для интеграции с AI-агентами.

## Architecture

```
Context Assembly → Triple Review → Consensus → [CoVe?] → Report
      ↓                ↓              ↓          ↓         ↓
  Landscape      Logic/Risk/    Aggregate    Verify    GitLab
  + Risk Map     Consistency    findings     escalated  inline
  + Patterns     (parallel)                  only       comments
```

**Что обязательно:** LLM API (OpenAI-совместимый). Всё остальное — опционально и gracefully деградирует.

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
| `PIPELINE_COVE_ENABLED` | ❌ | `true` | CoVe verification |

## Pipeline Steps

1. **Context Assembly** — landscape scan + risk map (Neo4j or LLM fallback) + similar patterns (Qdrant)
2. **Triple Review** — 3 parallel reviewers: Logic, Risk, Consistency
3. **Consensus** — aggregates findings, marks escalated
4. **CoVe** — single-step verification for escalated findings only
5. **Report** — JSON with inline comments + summary for GitLab

## MCP Tools

| Tool | Description |
|------|-------------|
| `review_snippet` | Full review of code snippet |
| `check_risk` | Risk analysis for changed files |
| `find_patterns` | Semantic search for similar patterns |
| `explain_symbol` | Explain symbol in codebase context |
| `query_graph` | Cypher query to dependency graph |

## License

MIT
