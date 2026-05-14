# AI Code Review Pipeline

> Production AI Code Review — Temporal + LangGraph + tree-sitter + MCP

Production-ready pipeline для ревью Merge Requests в GitLab. Оркестрация через Temporal, reasoning через LangGraph, структурный анализ через tree-sitter, векторный поиск через Qdrant, граф зависимостей через Neo4j. MCP-сервер для интеграции с AI-агентами.

## Architecture

```
Layer 0: Repo Intelligence  ← tree-sitter + Neo4j + Qdrant (pre-computed)
Layer 1: Context Assembly   ← Temporal workflow
Layer 2: Reasoning          ← Triple Review (3 models) + Consensus
Layer 3: Verification       ← CoVe (only for ESCALATE findings)
Layer 4: Reporting          ← GitLab JSON + Russian summary
Layer 5: Feedback Loop      ← PostgreSQL (human review tracking)
```

## Model Tiers

Все модели — алиасы через ENV. Ноль хардкода.

| Tier | ENV Variable | Use Case |
|------|-------------|----------|
| Cheap | `LLM_CHEAP_MODEL` | Landscape scan, question gen |
| Base | `LLM_BASE_MODEL` | Risk map, consistency review, report |
| Frontier | `LLM_FRONTIER_MODEL` | Logic/risk review, consensus, CoVe verdict |
| Embedding | `LLM_EMBEDDING_MODEL` | Code vectorization |

## Quick Start

```bash
# 1. Clone and install
git clone https://github.com/your-org/ai-code-review.git
cd ai-code-review
cp infra/.env.example .env
# Edit .env with your values

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

## Docker

```bash
# Development
npm run docker:up

# Production
npm run docker:prod
```

## ENV Configuration

See [infra/.env.example](infra/.env.example) for all variables. Key points:

- **LLM_BASE_URL** — internal IP of your OpenAI-compatible API gateway
- **LLM_*_MODEL** — model aliases, swap freely
- **PIPELINE_MAX_LLM_CALLS** — budget gate per MR review
- **PIPELINE_COVE_ENABLED** — enable/disable CoVe verification

## Pipeline Steps

1. **Context Assembly** — builds landscape + risk map + diff context
2. **Triple Review** — 3 parallel reviewers: Logic, Risk, Consistency
3. **Consensus** — aggregates findings, marks ESCALATE
4. **CoVe** — verification only for escalated findings (budget-gated)
5. **Report** — Russian-language JSON for GitLab inline comments + summary

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
