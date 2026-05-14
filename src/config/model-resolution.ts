/**
 * @module config/model-resolution
 * @description Model tier resolution and pipeline step → tier mapping.
 *
 * This module owns the infrastructure-dependent logic of resolving logical
 * model tiers to concrete model names and token limits. It depends on `env.ts`
 * and `llm/tiers.ts`, so it sits in the infrastructure layer of Clean Architecture.
 *
 * Domain types (PipelineStep, ModelTier, etc.) are imported from the pure
 * `types.ts` module, keeping the dependency direction correct:
 * infrastructure → domain (never the reverse).
 */

import { env } from './env.js';
import { getTierConfig } from '../llm/tiers.js';
import type { ModelTier, PipelineStep } from './types.js';

// Re-export ModelTier for backward compatibility
export type { ModelTier };

// ────────────────────────────────────────────────────────────────────────────
// Model tier helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Resolves a {@link ModelTier} to the concrete model name configured via
 * environment variables. This is the single place where the mapping from
 * logical tier to physical model identifier happens.
 *
 * @param tier - The model tier to resolve.
 * @returns The model name string (e.g. `env.LLM_CHEAP_MODEL`).
 */
export function resolveModelName(tier: ModelTier): string {
  switch (tier) {
    case 'cheap': return env.LLM_CHEAP_MODEL;
    case 'base': return env.LLM_BASE_MODEL;
    case 'frontier': return env.LLM_FRONTIER_MODEL;
    case 'embedding': return env.LLM_EMBEDDING_MODEL;
  }
}

/**
 * Resolves a {@link ModelTier} to the maximum output-token budget configured
 * via environment variables.
 *
 * @param tier - The model tier to resolve.
 * @returns The token limit (e.g. `env.LLM_CHEAP_MAX_TOKENS`).
 */
export function resolveMaxTokens(tier: ModelTier): number {
  switch (tier) {
    case 'cheap': return env.LLM_CHEAP_MAX_TOKENS;
    case 'base': return env.LLM_BASE_MAX_TOKENS;
    case 'frontier': return env.LLM_FRONTIER_MAX_TOKENS;
    case 'embedding': return 8192;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pipeline step → model tier mapping (from ENV)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Parse and validate the PIPELINE_MODEL_MAP from environment.
 *
 * The map is stored as a JSON string in the PIPELINE_MODEL_MAP env var.
 * Each key must be a valid PipelineStep, each value must be a valid ModelTier.
 */
function parseModelMap(): Readonly<Record<PipelineStep, ModelTier>> {
  const defaultMap: Record<PipelineStep, ModelTier> = {
    landscapeScan: 'cheap',
    riskMap: 'base',
    reviewLogic: 'frontier',
    reviewRisk: 'frontier',
    reviewConsistency: 'base',
    consensus: 'frontier',
    coveVerify: 'base',
    report: 'base',
  };

  try {
    const parsed = JSON.parse(env.PIPELINE_MODEL_MAP);

    // Validate keys and values
    const validSteps: PipelineStep[] = [
      'landscapeScan', 'riskMap', 'reviewLogic', 'reviewRisk',
      'reviewConsistency', 'consensus', 'coveVerify', 'report',
    ];
    const validTiers: ModelTier[] = ['cheap', 'base', 'frontier'];

    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!validSteps.includes(key as PipelineStep)) {
        console.warn(`[config] Unknown pipeline step in PIPELINE_MODEL_MAP: "${key}", ignoring`);
        continue;
      }
      if (!validTiers.includes(value as ModelTier)) {
        console.warn(`[config] Invalid tier "${value}" for step "${key}" in PIPELINE_MODEL_MAP, using default`);
        continue;
      }
      result[key] = value as string;
    }

    // Fill in any missing steps with defaults
    for (const step of validSteps) {
      if (!(step in result)) {
        result[step] = defaultMap[step];
      }
    }

    return result as unknown as Readonly<Record<PipelineStep, ModelTier>>;
  } catch (err) {
    console.warn(`[config] Failed to parse PIPELINE_MODEL_MAP, using defaults: ${err instanceof Error ? err.message : String(err)}`);
    return defaultMap;
  }
}

/**
 * Maps each pipeline step to its required LLM tier.
 *
 * The orchestrator reads this map at runtime to determine which model alias
 * and token budget to use for each step. The mapping is configurable via the
 * `PIPELINE_MODEL_MAP` environment variable (a JSON string); if parsing fails
 * or keys are missing, sensible defaults are used.
 */
export const PIPELINE_MODEL_MAP: Readonly<Record<PipelineStep, ModelTier>> = parseModelMap();
