/**
 * @module llm/tiers
 * @description Model-tier definitions for the AI Code Review LLM gateway.
 *
 * Each tier maps to a specific model and token budget, both sourced from
 * environment variables via `../config/env.js`.  No model names are
 * hard-coded — swapping models only requires updating the `.env` file.
 *
 * ### Tier Semantics
 *
 * | Tier       | Purpose                                          |
 * |------------|--------------------------------------------------|
 * | `cheap`    | Fast, low-cost calls (e.g. classification, guard)|
 * | `base`     | General-purpose review & analysis                |
 * | `frontier` | Deep reasoning, complex multi-step tasks         |
 * | `embedding`| Text → vector embedding                          |
 *
 * @example
 * ```ts
 * import { getTierConfig, LLM_TIERS } from './tiers.js';
 *
 * const cheap = getTierConfig('cheap');
 * console.log(cheap.model);      // e.g. "gpt-4o-mini"
 * console.log(cheap.maxTokens);  // e.g. 2048
 * ```
 */

import { env } from '../config/env.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Identifier for a model tier.
 *
 * Each variant corresponds to a cost/performance point in the pipeline.
 */
export type ModelTier = 'cheap' | 'base' | 'frontier' | 'embedding';

/**
 * Configuration for a single model tier.
 *
 * @property model     - The LLM model identifier (e.g. `"gpt-4o-mini"`).
 * @property maxTokens - Maximum number of tokens the model may generate.
 * @property dim       - Embedding vector dimensionality (only for the `embedding` tier).
 */
export interface TierConfig {
  /** LLM model identifier resolved from the environment. */
  model: string;

  /** Maximum output tokens allowed for this tier. */
  maxTokens: number;

  /**
   * Embedding vector dimensionality.
   * Only meaningful when `tier === 'embedding'`.
   */
  dim?: number;
}

// ── Tier Registry ────────────────────────────────────────────────────

/**
 * Immutable registry mapping each {@link ModelTier} to its resolved
 * {@link TierConfig}.
 *
 * Values are read **once** at module-load time from `env`, ensuring that
 * missing variables are caught early during startup.
 */
export const LLM_TIERS: Readonly<Record<ModelTier, TierConfig>> = {
  cheap: {
    model: env.LLM_CHEAP_MODEL,
    maxTokens: env.LLM_CHEAP_MAX_TOKENS,
  },

  base: {
    model: env.LLM_BASE_MODEL,
    maxTokens: env.LLM_BASE_MAX_TOKENS,
  },

  frontier: {
    model: env.LLM_FRONTIER_MODEL,
    maxTokens: env.LLM_FRONTIER_MAX_TOKENS,
  },

  embedding: {
    model: env.LLM_EMBEDDING_MODEL,
    maxTokens: 8192,
    dim: env.LLM_EMBEDDING_DIM,
  },
} as const;

// ── Helpers ──────────────────────────────────────────────────────────

/**
 * Retrieve the configuration for a given model tier.
 *
 * @param tier - The tier to look up.
 * @returns The corresponding {@link TierConfig}.
 * @throws {Error} If the tier identifier is invalid (should never happen
 *   with TypeScript exhaustiveness checking, but guards runtime misuse).
 *
 * @example
 * ```ts
 * const config = getTierConfig('base');
 * // { model: "gpt-4o", maxTokens: 4096 }
 * ```
 */
export function getTierConfig(tier: ModelTier): TierConfig {
  const config = LLM_TIERS[tier];
  if (!config) {
    throw new Error(`Unknown model tier: "${tier}"`);
  }
  return { ...config }; // return a shallow copy to prevent mutation
}
