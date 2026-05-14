import type { ConsensusFinding, ReviewFinding } from '../../config/defaults.js';
import { llmClient } from '../../llm/client.js';
import { budgetTracker } from '../../llm/budget.js';
import { loadPrompt } from '../../util/prompts.js';

export interface ConsensusResult {
  findings: ConsensusFinding[];
  agreedCount: number;
  contestedCount: number;
  escalateCount: number;
}

/**
 * Consensus analyzer — aggregates findings from three reviewers.
 * Uses `frontier` tier per PIPELINE_MODEL_MAP.
 */
export async function aggregateConsensus(input: {
  logic: ReviewFinding[];
  risk: ReviewFinding[];
  consistency: ReviewFinding[];
}): Promise<ConsensusResult> {
  budgetTracker.checkBudget();

  const systemPrompt = await loadPrompt('consensus');
  const userPrompt = [
    'Aggregate these three reviews into consensus output.',
    '',
    `<review_1_logic>${JSON.stringify(input.logic)}</review_1_logic>`,
    `<review_2_risk>${JSON.stringify(input.risk)}</review_2_risk>`,
    `<review_3_consistency>${JSON.stringify(input.consistency)}</review_3_consistency>`,
    '',
    'Rules:',
    '- AGREED: 2+ reviewers flag same location/issue',
    '- CONTESTED: only 1 reviewer flags, or reviewers contradict',
    '- If any source CONFIDENCE < 0.8 — flag for deeper review',
    '',
    'For each finding:',
    'STATUS: <agreed/contested>',
    'ISSUE: <unified description>',
    'SOURCES: <which models flagged this>',
    'LOCATIONS: <all referenced locations>',
    'CONFIDENCE: <average of source confidences>',
    'ESCALATE: <yes/no>',
    'REASON: <why agreed or why contested>',
    '',
    'After all findings:',
    'AGREED_COUNT: <n>',
    'CONTESTED_COUNT: <n>',
    'ESCALATE_COUNT: <n>',
  ].join('\n');

  const result = await llmClient.complete('frontier', systemPrompt, userPrompt);
  return parseConsensus(result.content);
}

function parseConsensus(raw: string): ConsensusResult {
  const findings: ConsensusFinding[] = [];
  const blocks = raw.split(/(?=STATUS:)/g).filter(b => b.trim());

  for (const block of blocks) {
    const statusRaw = extractField(block, 'STATUS');
    if (!statusRaw) continue;

    // Map 'contested' from prompt to 'disputed' in interface
    const status: ConsensusFinding['status'] =
      statusRaw.toLowerCase() === 'contested' ? 'disputed'
      : statusRaw.toLowerCase() === 'dismissed' ? 'dismissed'
      : 'agreed';

    const confidence = Number.parseFloat(extractField(block, 'CONFIDENCE') ?? '0.5');
    const escalate = extractField(block, 'ESCALATE')?.toLowerCase() === 'yes' || confidence < 0.8;

    findings.push({
      status,
      issue: extractField(block, 'ISSUE') ?? '',
      sources: (extractField(block, 'SOURCES') ?? '').split(',').map(s => s.trim()),
      locations: (extractField(block, 'LOCATIONS') ?? '').split(',').map(s => s.trim()),
      confidence,
      escalate,
      reason: extractField(block, 'REASON') ?? '',
    });
  }

  const agreedCount = findings.filter(f => f.status === 'agreed').length;
  const contestedCount = findings.filter(f => f.status === 'disputed').length;
  const escalateCount = findings.filter(f => f.escalate).length;

  return { findings, agreedCount, contestedCount, escalateCount };
}

function extractField(block: string, field: string): string | undefined {
  const regex = new RegExp(`${field}:\\s*(.+)`, 'i');
  const match = block.match(regex);
  return match?.[1]?.trim();
}
