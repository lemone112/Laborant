import type { ReviewFinding } from '../../config/defaults.js';
import type { ILLMClient } from '../../llm/client.js';
import { coerceEmotion } from '../../util/finding-utils.js';
import { runReview, type ReviewConfig } from './common.js';
import type { PipelineContext } from '../context-assembly/builder.js';

/**
 * JSON schema describing the expected structured output from the logic reviewer.
 */
const LOGIC_SCHEMA = `{
  "findings": [
    {
      "issue": "<what>",
      "location": "<file:line>",
      "cornerCase": "<yes/no>",
      "confidence": <0.0-1.0>,
      "emotion": "<certain|uneasy|speculating|confused|satisfied|concerned>",
      "evidence": "<exact code anchor>"
    }
  ]
}`;

/** Review configuration for the Logic reviewer. */
const LOGIC_CONFIG: ReviewConfig = {
  promptName: 'review-logic',
  tier: 'frontier',
  schemaDescription: LOGIC_SCHEMA,
  instruction: 'Review this change for logic and correctness.',
  mapFinding: (f: any) => ({
    issue: String(f.issue ?? ''),
    location: String(f.location ?? 'unknown'),
    cornerCase: String(f.cornerCase ?? 'no'),
    confidence: Number(f.confidence ?? 0.5),
    emotion: coerceEmotion(f.emotion),
    evidence: String(f.evidence ?? ''),
  }),
};

/**
 * Logic reviewer — finds correctness issues in changed code.
 * Uses `frontier` tier per PIPELINE_MODEL_MAP.
 */
export async function reviewLogic(context: PipelineContext, llm: ILLMClient): Promise<ReviewFinding[]> {
  return runReview(context, llm, LOGIC_CONFIG);
}
