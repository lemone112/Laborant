/**
 * @module config/defaults
 * @description Barrel re-export module for backward compatibility.
 *
 * All types and values have been split into two focused modules:
 * - `types.ts` — pure domain types with no infrastructure dependencies
 * - `model-resolution.ts` — tier resolution and PIPELINE_MODEL_MAP
 *
 * This file re-exports everything so existing imports continue to work
 * without any changes. New code should import from the specific module
 * that matches its dependency profile:
 * - Domain code → `config/types.js`
 * - Infrastructure code → `config/model-resolution.js`
 */

// Pure domain types (no env/infra dependency)
export type { ModelTier, PipelineStep } from './types.js';
export { EMOTION, SEVERITY } from './types.js';
export type { Emotion, Severity } from './types.js';
export type {
  LandscapeArtifact,
  RiskMapEntry,
  ReviewFinding,
  ConsensusFinding,
  CoVeQuestion,
  CoVeAnswer,
  CoVeVerdict,
  ReportInline,
  ReviewOutput,
} from './types.js';

// Infrastructure-dependent resolution logic
export { resolveModelName, resolveMaxTokens, PIPELINE_MODEL_MAP } from './model-resolution.js';
