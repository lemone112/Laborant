import type { ReviewFinding } from '../../config/defaults.js';
import type { ILLMClient } from '../../llm/client.js';
import { coerceEmotion } from '../../util/finding-utils.js';
import { runReview, type ReviewConfig } from './common.js';
import type { PipelineContext } from '../context-assembly/builder.js';

/**
 * JSON schema describing the expected structured output from the consistency reviewer.
 *
 * The LLM returns `deviation` and `pattern` fields which are mapped to
 * `issue` and `location`/`evidence` in the unified {@link ReviewFinding} shape.
 */
const CONSISTENCY_SCHEMA = `{
  "findings": [
    {
      "deviation": "<what diverges>",
      "pattern": "<which pattern from landscape is violated>",
      "intentionalCheck": "<yes/no/unclear>",
      "cornerCase": "<yes/no>",
      "confidence": <0.0-1.0>,
      "emotion": "<certain|uneasy|speculating|confused|satisfied|concerned>",
      "evidence": "<exact code anchor + landscape anchor>"
    }
  ]
}`;

/** Review configuration for the Consistency reviewer. */
const CONSISTENCY_CONFIG: ReviewConfig = {
  promptName: 'review-consistency',
  tier: 'base',
  schemaDescription: CONSISTENCY_SCHEMA,
  instruction: 'Review this change for consistency with codebase patterns.',
  mapFinding: (f: any) => ({
    issue: String(f.deviation ?? ''),
    location: String(f.evidence ?? 'unknown'),
    cornerCase: String(f.cornerCase ?? 'no'),
    confidence: Number(f.confidence ?? 0.5),
    emotion: coerceEmotion(f.emotion),
    evidence: String(f.evidence ?? ''),
  }),
};

/**
 * Consistency reviewer — finds deviations from established patterns and conventions.
 * Uses `base` tier per PIPELINE_MODEL_MAP.
 */
export async function reviewConsistency(context: PipelineContext, llm: ILLMClient): Promise<ReviewFinding[]> {
  return runReview(context, llm, CONSISTENCY_CONFIG);
}
