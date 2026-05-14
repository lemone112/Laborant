import type { ReviewFinding } from '../../config/defaults.js';
import type { LLMClient } from '../../llm/client.js';
import { coerceEmotion } from '../../util/finding-utils.js';
import { loadPrompt } from '../../util/prompts.js';
import { requestStructured } from '../../util/structured-output.js';
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

/**
 * Risk reviewer — finds breakage in modules indirectly affected by this change.
 * Uses `frontier` tier per PIPELINE_MODEL_MAP.
 *
 * Requests structured JSON output from the LLM and parses it directly,
 * mapping `risk` → `issue` and `propagation` → `location` in the output.
 */
export async function reviewRisk(context: PipelineContext, llm: LLMClient): Promise<ReviewFinding[]> {
  const systemPrompt = await loadPrompt('review-risk');
  const userPrompt = [
    'Review this change for risk propagation.',
    '',
    `<landscape>${JSON.stringify(context.landscape)}</landscape>`,
    `<risk_map>${JSON.stringify(context.riskMap)}</risk_map>`,
    `<diff>${context.diff}</diff>`,
  ].join('\n');

  const result = await requestStructured<{ findings?: unknown[] }>(
    llm,
    'frontier',
    systemPrompt,
    userPrompt,
    RISK_SCHEMA,
  );

  const findings = Array.isArray(result.findings) ? result.findings : [];
  return findings.map((f: any) => ({
    issue: String(f.risk ?? ''),
    location: String(f.propagation ?? 'unknown'),
    cornerCase: String(f.cornerCase ?? 'no'),
    confidence: Number(f.confidence ?? 0.5),
    emotion: coerceEmotion(f.emotion),
    evidence: String(f.evidence ?? ''),
  }));
}
