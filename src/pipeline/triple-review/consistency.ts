import type { ReviewFinding } from '../../config/defaults.js';
import type { LLMClient } from '../../llm/client.js';
import { coerceEmotion } from '../../util/finding-utils.js';
import { loadPrompt } from '../../util/prompts.js';
import { requestStructured } from '../../util/structured-output.js';
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

/**
 * Consistency reviewer — finds deviations from established patterns and conventions.
 * Uses `base` tier per PIPELINE_MODEL_MAP.
 *
 * Requests structured JSON output from the LLM and parses it directly,
 * mapping `deviation` → `issue` and `evidence` → both `location` and `evidence`.
 */
export async function reviewConsistency(context: PipelineContext, llm: LLMClient): Promise<ReviewFinding[]> {
  const systemPrompt = await loadPrompt('review-consistency');
  const userPrompt = [
    'Review this change for consistency with codebase patterns.',
    '',
    `<landscape>${JSON.stringify(context.landscape)}</landscape>`,
    `<risk_map>${JSON.stringify(context.riskMap)}</risk_map>`,
    `<diff>${context.diff}</diff>`,
  ].join('\n');

  const result = await requestStructured<{ findings?: unknown[] }>(
    llm,
    'base',
    systemPrompt,
    userPrompt,
    CONSISTENCY_SCHEMA,
  );

  const findings = Array.isArray(result.findings) ? result.findings : [];
  return findings.map((f: any) => ({
    issue: String(f.deviation ?? ''),
    location: String(f.evidence ?? 'unknown'),
    cornerCase: String(f.cornerCase ?? 'no'),
    confidence: Number(f.confidence ?? 0.5),
    emotion: coerceEmotion(f.emotion),
    evidence: String(f.evidence ?? ''),
  }));
}
