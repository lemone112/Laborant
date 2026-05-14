import type { ReviewFinding } from '../../config/defaults.js';
import { EMOTION } from '../../config/defaults.js';
import { llmClient } from '../../llm/client.js';
import { budgetTracker } from '../../llm/budget.js';
import { loadPrompt } from '../../util/prompts.js';
import type { PipelineContext } from '../context-assembly/builder.js';

/**
 * Logic reviewer — finds correctness issues in changed code.
 * Uses `frontier` tier per PIPELINE_MODEL_MAP.
 */
export async function reviewLogic(context: PipelineContext): Promise<ReviewFinding[]> {
  budgetTracker.checkBudget();

  const systemPrompt = await loadPrompt('review-logic');
  const userPrompt = [
    'Review this change for logic and correctness.',
    '',
    `<landscape>${JSON.stringify(context.landscape)}</landscape>`,
    `<risk_map>${JSON.stringify(context.riskMap)}</risk_map>`,
    `<diff>${context.diff}</diff>`,
    '',
    'For each finding output:',
    'ISSUE: <what>',
    'LOCATION: <file:line>',
    'CORNER_CASE: <yes/no>',
    'CONFIDENCE: <0.0–1.0>',
    'EMOTION: <certain | uneasy | speculating | confused | satisfied | concerned>',
    'EVIDENCE: <exact code anchor>',
    '',
    'Be honest. Flag uncertainty explicitly.',
    'NEVER output findings without EVIDENCE.',
    'NEVER skip CONFIDENCE and EMOTION.',
  ].join('\n');

  const result = await llmClient.complete('frontier', systemPrompt, userPrompt);
  return parseFindings(result.content);
}

function parseFindings(raw: string): ReviewFinding[] {
  const findings: ReviewFinding[] = [];
  const blocks = raw.split(/(?=ISSUE:|RISK:|DEVIATION:)/g).filter(b => b.trim());

  for (const block of blocks) {
    const issue = extractField(block, 'ISSUE');
    if (!issue) continue;

    findings.push({
      issue,
      location: extractField(block, 'LOCATION') ?? 'unknown',
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
