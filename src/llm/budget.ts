/**
 * @module llm/budget
 * @description Budget tracker for the AI Code Review LLM gateway.
 *
 * Provides a singleton {@link BudgetTracker} that enforces per-pipeline
 * spending limits on **call count** and **estimated cost**.  A new
 * pipeline run should call {@link BudgetTracker.reset} at startup so that
 * counters are fresh; the same instance is then shared across all LLM
 * calls in that run.
 *
 * ### Cost Model
 *
 * Per-tier cost-per-million-tokens (USD).  These defaults mirror
 * OpenAI's public pricing and can be overridden via the constructor.
 *
 * | Tier       | $/1M tokens |
 * |------------|-------------|
 * | `cheap`    | 0.15        |
 * | `base`     | 2.50        |
 * | `frontier` | 15.00       |
 * | `embedding`| 0.02        |
 *
 * ### Thread Safety
 *
 * Designed for **single-process Node.js**.  No mutex or atomic ops are
 * needed because the event loop guarantees serial execution of
 * synchronous code between `await` points.
 *
 * @example
 * ```ts
 * const budget = new BudgetTracker();
 * budget.reset();                        // clear at pipeline start
 * budget.checkBudget();                  // throws if limits exceeded
 * budget.recordCall('base', 1_200);      // log a call
 * console.log(budget.getStats());        // { totalCalls: 1, … }
 * ```
 */

import { env } from '../config/env.js';
import type { ModelTier } from './tiers.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Cost per 1M tokens for each tier (in USD).
 * Pass a partial override to the {@link BudgetTracker} constructor.
 */
export interface TierPricing {
  cheap: number;
  base: number;
  frontier: number;
  embedding: number;
}

/**
 * Snapshot of current budget usage returned by {@link BudgetTracker.getStats}.
 */
export interface BudgetStats {
  /** Total number of LLM calls recorded. */
  totalCalls: number;

  /** Total tokens consumed across all calls. */
  totalTokens: number;

  /** Estimated total cost in USD. */
  totalCostUSD: number;

  /** Number of calls made per tier. */
  callsByTier: Record<ModelTier, number>;

  /** Tokens consumed per tier. */
  tokensByTier: Record<ModelTier, number>;
}

/**
 * Error thrown when a budget limit is exceeded.
 */
export class BudgetExceededError extends Error {
  /** The limit type that was exceeded. */
  public readonly limit: 'calls' | 'cost';

  /** The current value at the time of the check. */
  public readonly current: number;

  /** The configured maximum. */
  public readonly maximum: number;

  constructor(limit: 'calls' | 'cost', current: number, maximum: number) {
    const message =
      limit === 'calls'
        ? `LLM call budget exceeded: ${current} calls (max ${maximum})`
        : `LLM cost budget exceeded: $${current.toFixed(4)} (max $${maximum.toFixed(4)})`;
    super(message);
    this.name = 'BudgetExceededError';
    this.limit = limit;
    this.current = current;
    this.maximum = maximum;
  }
}

// ── Constants ────────────────────────────────────────────────────────

/**
 * Default per-tier cost per 1M tokens (USD).
 * Mirrors approximate OpenAI pricing as of 2025.
 */
const DEFAULT_PRICING: Readonly<TierPricing> = {
  cheap: 0.15,
  base: 2.5,
  frontier: 15.0,
  embedding: 0.02,
};

// ── Implementation ───────────────────────────────────────────────────

/**
 * Tracks LLM call budgets for a single pipeline run.
 *
 * Call {@link reset} at the beginning of each pipeline invocation to
 * zero-out counters.  Then call {@link recordCall} after every LLM
 * interaction and {@link checkBudget} before each call to guard against
 * overspend.
 */
export class BudgetTracker {
  // ── Configuration ──

  /** Maximum number of LLM calls allowed per pipeline run. */
  private readonly maxCalls: number;

  /** Maximum estimated cost (USD) allowed per pipeline run. */
  private readonly maxCostUSD: number;

  /** Per-tier pricing ($/1M tokens). */
  private readonly pricing: Readonly<TierPricing>;

  // ── Counters ──

  private totalCalls = 0;
  private totalTokens = 0;
  private totalCostUSD = 0;

  private readonly callsByTier: Record<ModelTier, number> = {
    cheap: 0,
    base: 0,
    frontier: 0,
    embedding: 0,
  };

  private readonly tokensByTier: Record<ModelTier, number> = {
    cheap: 0,
    base: 0,
    frontier: 0,
    embedding: 0,
  };

  /**
   * Create a new budget tracker.
   *
   * @param options - Optional overrides for limits and pricing.
   * @param options.maxCalls    - Max LLM calls per pipeline run
   *   (defaults to `env.PIPELINE_MAX_LLM_CALLS`).
   * @param options.maxCostUSD  - Max estimated cost in USD per pipeline run
   *   (defaults to `env.PIPELINE_MAX_COST_USD`).
   * @param options.pricing     - Partial override of per-tier $/1M token pricing.
   */
  constructor(options?: {
    maxCalls?: number;
    maxCostUSD?: number;
    pricing?: Partial<TierPricing>;
  }) {
    this.maxCalls = options?.maxCalls ?? env.PIPELINE_MAX_LLM_CALLS;
    this.maxCostUSD = options?.maxCostUSD ?? env.PIPELINE_MAX_COST_USD;
    this.pricing = {
      cheap: options?.pricing?.cheap ?? DEFAULT_PRICING.cheap,
      base: options?.pricing?.base ?? DEFAULT_PRICING.base,
      frontier: options?.pricing?.frontier ?? DEFAULT_PRICING.frontier,
      embedding: options?.pricing?.embedding ?? DEFAULT_PRICING.embedding,
    };
  }

  // ── Public API ───────────────────────────────────────────────────

  /**
   * Check whether the budget has been exceeded and throw if so.
   *
   * Call this **before** making an LLM request to fail fast when limits
   * are already reached.
   *
   * @throws {BudgetExceededError} If the call count or cost limit has
   *   been exceeded.
   */
  checkBudget(): void {
    if (this.totalCalls >= this.maxCalls) {
      throw new BudgetExceededError('calls', this.totalCalls, this.maxCalls);
    }
    if (this.totalCostUSD >= this.maxCostUSD) {
      throw new BudgetExceededError('cost', this.totalCostUSD, this.maxCostUSD);
    }
  }

  /**
   * Record a completed LLM call and update budget counters.
   *
   * @param tier   - The model tier used for the call.
   * @param tokens - Total tokens consumed (prompt + completion).
   *
   * @example
   * ```ts
   * budget.recordCall('base', 3_500);
   * ```
   */
  recordCall(tier: ModelTier, tokens: number): void {
    this.totalCalls += 1;
    this.totalTokens += tokens;

    const costPer1M = this.pricing[tier];
    const callCost = (tokens / 1_000_000) * costPer1M;
    this.totalCostUSD += callCost;

    this.callsByTier[tier] += 1;
    this.tokensByTier[tier] += tokens;
  }

  /**
   * Return a snapshot of current budget usage.
   *
   * The returned object is a **copy** — mutating it will not affect the
   * tracker's internal state.
   *
   * @returns A {@link BudgetStats} snapshot.
   */
  getStats(): BudgetStats {
    return {
      totalCalls: this.totalCalls,
      totalTokens: this.totalTokens,
      totalCostUSD: this.totalCostUSD,
      callsByTier: { ...this.callsByTier },
      tokensByTier: { ...this.tokensByTier },
    };
  }

  /**
   * Reset all counters to zero.
   *
   * Should be called at the **start** of every pipeline run so that
   * budget tracking is fresh.
   */
  reset(): void {
    this.totalCalls = 0;
    this.totalTokens = 0;
    this.totalCostUSD = 0;

    const tiers: ModelTier[] = ['cheap', 'base', 'frontier', 'embedding'];
    for (const tier of tiers) {
      this.callsByTier[tier] = 0;
      this.tokensByTier[tier] = 0;
    }
  }
}

/**
 * Create a fresh BudgetTracker instance for a single pipeline run.
 * Each review MUST use its own tracker to avoid budget conflicts.
 */
export function createBudgetTracker(options?: ConstructorParameters<typeof BudgetTracker>[0]): BudgetTracker {
  return new BudgetTracker(options);
}
