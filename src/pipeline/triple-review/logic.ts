import type { ReviewFinding } from '../../config/defaults.js';
import type { LLMClient } from '../../llm/client.js';
import { coerceEmotion } from '../../util/finding-utils.js';
import { loadPrompt } from '../../util/prompts.js';
import { requestStructured } from '../../util/structured-output.js';
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

/**
 * Logic reviewer — finds correctness issues in changed code.
 * Uses `frontier` tier per PIPELINE_MODEL_MAP.
 *
 * Requests structured JSON output from the LLM and parses it directly,
 * eliminating the need for fragile regex-based field extraction.
 */
export async function reviewLogic(context: PipelineContext, llm: LLMClient): Promise<ReviewFinding[]> {
  const systemPrompt = await loadPrompt('review-logic');
  const userPrompt = [
    'Review this change for logic and correctness.',
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
    LOGIC_SCHEMA,
  );

  const findings = Array.isArray(result.findings) ? result.findings : [];
  return findings.map((f: any) => ({
    issue: String(f.issue ?? ''),
    location: String(f.location ?? 'unknown'),
    cornerCase: String(f.cornerCase ?? 'no'),
    confidence: Number(f.confidence ?? 0.5),
    emotion: coerceEmotion(f.emotion),
    evidence: String(f.evidence ?? ''),
  }));
}
