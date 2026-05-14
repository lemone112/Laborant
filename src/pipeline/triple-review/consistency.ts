import type { ReviewFinding } from '../../config/defaults.js';
import { EMOTION } from '../../config/defaults.js';
import { llmClient } from '../../llm/client.js';
import { budgetTracker } from '../../llm/budget.js';
import { loadPrompt } from '../../util/prompts.js';
import type { PipelineContext } from '../context-assembly/builder.js';

/**
 * Consistency reviewer — finds deviations from established patterns and conventions.
 * Uses `base` tier per PIPELINE_MODEL_MAP.
 */
export async function reviewConsistency(context: PipelineContext): Promise<ReviewFinding[]> {
  budgetTracker.checkBudget();

  const systemPrompt = await loadPrompt('review-consistency');
  const userPrompt = [
    'Review this change for consistency with codebase patterns.',
    '',
    `<landscape>${JSON.stringify(context.landscape)}</landscape>`,
    `<risk_map>${JSON.stringify(context.riskMap)}</risk_map>`,
    `<diff>${context.diff}</diff>`,
    '',
    'For each finding:',
    'DEVIATION: <what diverges>',
    'PATTERN: <which pattern from landscape is violated>',
    'INTENTIONAL_CHECK: <could this be deliberate — yes/no/unclear>',
    'CORNER_CASE: <yes/no>',
    'CONFIDENCE: <0.0–1.0>',
    'EMOTION: <certain | uneasy | speculating | confused | satisfied | concerned>',
    'EVIDENCE: <exact code anchor + landscape anchor>',
    '',
    'NEVER flag items marked INTENTIONAL in landscape.',
    'NEVER skip CONFIDENCE and EMOTION.',
  ].join('\n');

  const result = await llmClient.complete('base', systemPrompt, userPrompt);
  return parseConsistencyFindings(result.content);
}

function parseConsistencyFindings(raw: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const blocks = raw.split(/(?=DEVIATION:)/g).filter(b => b.trim());

  for (const block of blocks) {
    const deviation = extractField(block, 'DEVIATION');
    if (!deviation) continue;

    findings.push({
      issue: deviation,
      location: extractField(block, 'EVIDENCE') ?? 'unknown',
      cornerCase: extractField(block, 'CORNER_CASE') ?? 'no',
      confidence: Number.parseFloat(extractField(block, 'CONFIDENCE') ?? '0.5'),
      emotion: coerceEmotion(extractField(block, 'EMOTION')),
      evidence: extractField(block, 'EVIDENCE') ?? '',
    });
  }

  return findings;
}

function extractField(block: string, field: string): string | undefined {
  const regex = new RegExp(`${field}:\\s*(.+)`, 'i');
  const match = block.match(regex);
  return match?.[1]?.trim();
}

function coerceEmotion(raw: string | undefined): ReviewFinding['emotion'] {
  const val = (raw ?? '').toLowerCase().trim();
  if (Object.values(EMOTION).includes(val as any)) return val as ReviewFinding['emotion'];
  return 'uneasy';
}
