/**
 * @module pipeline/triple-review/common
 * @description Shared utilities for the Triple Review step.
 *
 * All three reviewers (Logic, Risk, Consistency) follow the same pattern:
 * 1. Load a prompt template
 * 2. Build a user prompt with landscape + risk map + diff
 * 3. Request structured JSON output from the LLM
 * 4. Parse the response into ReviewFinding[]
 *
 * This module extracts the common logic so that adding a new review type
 * only requires: a prompt file + a field mapping function + a call to
 * {@link runReview}. This satisfies the Open/Closed Principle — the
 * review pipeline is open for extension but closed for modification.
 */

import type { ReviewFinding } from '../../config/defaults.js';
import type { ILLMClient } from '../../llm/client.js';
import type { ModelTier } from '../../config/types.js';
import { coerceEmotion } from '../../util/finding-utils.js';
import { requestStructured } from '../../util/structured-output.js';
import type { PipelineContext } from '../context-assembly/builder.js';

/**
 * Configuration for a single review type.
 *
 * Each reviewer provides:
 * - `promptName` — the prompt template file name (without .md)
 * - `tier` — the LLM model tier to use
 * - `schemaDescription` — JSON schema description for structured output
 * - `mapFinding` — function that maps a raw LLM finding to ReviewFinding
 */
export interface ReviewConfig<T = Record<string, unknown>> {
  /** Prompt template name (loaded from prompts/{name}.md). */
  promptName: string;
  /** LLM model tier for this review type. */
  tier: ModelTier;
  /** JSON schema description for the structured output. */
  schemaDescription: string;
  /** Instruction line included in the user prompt. */
  instruction: string;
  /** Maps a raw finding from the LLM response to a ReviewFinding. */
  mapFinding: (raw: T) => ReviewFinding;
}

/**
 * Generic review runner that executes the common review pattern.
 *
 * @param context   - The assembled pipeline context.
 * @param llm       - The LLM client to use.
 * @param config    - The review configuration.
 * @returns An array of findings produced by the review.
 */
export async function runReview<T = Record<string, unknown>>(
  context: PipelineContext,
  llm: ILLMClient,
  config: ReviewConfig<T>,
): Promise<ReviewFinding[]> {
  const { loadPrompt } = await import('../../util/prompts.js');
  const systemPrompt = await loadPrompt(config.promptName);

  const userPrompt = [
    config.instruction,
    '',
    `<landscape>${JSON.stringify(context.landscape)}</landscape>`,
    `<risk_map>${JSON.stringify(context.riskMap)}</risk_map>`,
    `<diff>${context.diff}</diff>`,
  ].join('\n');

  const result = await requestStructured<{ findings?: unknown[] }>(
    llm,
    config.tier,
    systemPrompt,
    userPrompt,
    config.schemaDescription,
  );

  const findings = Array.isArray(result.findings) ? result.findings : [];
  return findings.map((f: any) => config.mapFinding(f as T));
}
