import type { ReviewFinding } from '../../config/defaults.js';
import { EMOTION } from '../../config/defaults.js';
import { llmClient } from '../../llm/client.js';
import { budgetTracker } from '../../llm/budget.js';
import { loadPrompt } from '../../util/prompts.js';
import type { PipelineContext } from '../context-assembly/builder.js';

/**
 * Risk reviewer — finds breakage in modules indirectly affected by this change.
 * Uses `frontier` tier per PIPELINE_MODEL_MAP.
 */
export async function reviewRisk(context: PipelineContext): Promise<ReviewFinding[]> {
  budgetTracker.checkBudget();

  const systemPrompt = await loadPrompt('review-risk');
  const userPrompt = [
    'Review this change for risk propagation.',
    '',
    `<landscape>${JSON.stringify(context.landscape)}</landscape>`,
    `<risk_map>${JSON.stringify(context.riskMap)}</risk_map>`,
    `<diff>${context.diff}</diff>`,
    '',
    'For each finding:',
    'RISK: <what breaks>',
    'PROPAGATION: <changed → direct → indirect path>',
    'CORNER_CASE: <yes/no>',
    'CONFIDENCE: <0.0–1.0>',
    'EMOTION: <certain | uneasy | speculating | confused | satisfied | concerned>',
    'EVIDENCE: <what in the diff triggers this risk>',
    '',
    'Be honest. Speculative risks MUST be marked with low confidence.',
    'NEVER output findings without PROPAGATION path.',
    'NEVER skip CONFIDENCE and EMOTION.',
  ].join('\n');

  const result = await llmClient.complete('frontier', systemPrompt, userPrompt);
  return parseRiskFindings(result.content);
}

function parseRiskFindings(raw: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const blocks = raw.split(/(?=RISK:)/g).filter(b => b.trim());

  for (const block of blocks) {
    const risk = extractField(block, 'RISK');
    if (!risk) continue;

    findings.push({
      issue: risk,
      location: extractField(block, 'PROPAGATION') ?? 'unknown',
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
