import type { ReviewFinding } from '../../config/defaults.js';
import type { ILLMClient } from '../../llm/client.js';
import { coerceEmotion } from '../../util/finding-utils.js';
import { runReview, type ReviewConfig } from './common.js';
import type { PipelineContext } from '../context-assembly/builder.js';

/**
 * JSON schema describing the expected structured output from the risk reviewer.
 *
 * The LLM returns `risk` and `propagation` fields which are mapped to
 * `issue` and `location` in the unified {@link ReviewFinding} shape.
 */
const RISK_SCHEMA = `{
  "findings": [
    {
      "risk": "<what breaks>",
      "propagation": "<changed → direct → indirect path>",
      "cornerCase": "<yes/no>",
      "confidence": <0.0-1.0>,
      "emotion": "<certain|uneasy|speculating|confused|satisfied|concerned>",
      "evidence": "<what in the diff triggers this risk>"
    }
  ]
}`;

/** Review configuration for the Risk reviewer. */
const RISK_CONFIG: ReviewConfig = {
  promptName: 'review-risk',
  tier: 'frontier',
  schemaDescription: RISK_SCHEMA,
  instruction: 'Review this change for risk propagation.',
  mapFinding: (f: any) => ({
    issue: String(f.risk ?? ''),
    location: String(f.propagation ?? 'unknown'),
    cornerCase: String(f.cornerCase ?? 'no'),
    confidence: Number(f.confidence ?? 0.5),
    emotion: coerceEmotion(f.emotion),
    evidence: String(f.evidence ?? ''),
  }),
};

/**
 * Risk reviewer — finds breakage in modules indirectly affected by this change.
 * Uses `frontier` tier per PIPELINE_MODEL_MAP.
 */
export async function reviewRisk(context: PipelineContext, llm: ILLMClient): Promise<ReviewFinding[]> {
  return runReview(context, llm, RISK_CONFIG);
}
