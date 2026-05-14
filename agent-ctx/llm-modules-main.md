# Task: Create LLM Module Files for AI Code Review

## Task ID: llm-modules

## Summary

Created four TypeScript files for the AI Code Review LLM gateway layer:

### Files Created

1. **`src/config/env.ts`** — Centralised environment-variable accessor (dependency for all three requested files)
   - Reads and validates all env vars from `.env.example`
   - Provides typed, frozen `env` object
   - Throws at startup if required vars are missing

2. **`src/llm/tiers.ts`** — Model tier definitions
   - `ModelTier` type: `'cheap' | 'base' | 'frontier' | 'embedding'`
   - `TierConfig` interface with `model`, `maxTokens`, and optional `dim`
   - `LLM_TIERS` registry reading all values from `env`
   - `getTierConfig(tier)` helper returning a shallow copy

3. **`src/llm/budget.ts`** — Budget tracker
   - `BudgetTracker` class with `checkBudget()`, `recordCall()`, `getStats()`, `reset()`
   - `BudgetExceededError` custom error class with `limit`, `current`, `maximum` properties
   - Default pricing: cheap=$0.15/1M, base=$2.50/1M, frontier=$15/1M, embedding=$0.02/1M
   - Constructor accepts optional overrides for limits and pricing
   - `budgetTracker` singleton exported

4. **`src/llm/client.ts`** — OpenAI SDK wrapper
   - `LLMClient` class with `chat()`, `complete()`, `embed()` methods
   - Tier-based model selection via `getTierConfig()`
   - Budget enforcement before each call via `budgetTracker.checkBudget()`
   - JSON mode support via `response_format: { type: 'json_object' }`
   - Retry logic: max 3 attempts with exponential backoff (1s → 2s → 4s)
   - Retryable errors: HTTP 429, 5xx, network timeouts (ECONNRESET, ETIMEDOUT, etc.)
   - Structured logging for every request/response/retry/error
   - `llmClient` singleton exported

### TypeScript Compilation

All four files compile cleanly with the project's `tsconfig.json` (the only remaining error is a pre-existing issue in `src/repo-intelligence/ast-indexer.ts`, unrelated to this task).

### Architecture

```
env.ts ──▶ tiers.ts ──▶ client.ts
                ──▶ budget.ts ──▶ client.ts
```

All imports use `.js` extensions as required by `NodeNext` module resolution.
