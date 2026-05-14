import type { ConsensusFinding, ReviewFinding } from '../../config/defaults.js';
import type { LLMClient } from '../../llm/client.js';
import { loadPrompt } from '../../util/prompts.js';
import { requestStructured } from '../../util/structured-output.js';
import { createHash } from 'node:crypto';

export interface ConsensusResult {
  findings: ConsensusFinding[];
  agreedCount: number;
  contestedCount: number;
  escalateCount: number;
}

/**
 * JSON schema describing the expected structured output from the consensus step.
 *
 * The LLM returns findings with `status`, `sources`, and `locations` as arrays,
 * plus top-level counts that are used directly instead of re-counting.
 */
const CONSENSUS_SCHEMA = `{
  "findings": [
    {
      "status": "<agreed|disputed>",
      "issue": "<unified description>",
      "sources": ["<which models flagged this>"],
      "locations": ["<all referenced locations>"],
      "confidence": <0.0-1.0>,
      "escalate": <true|false>,
      "reason": "<why agreed or why contested>"
    }
  ],
  "agreedCount": <number>,
  "contestedCount": <number>,
  "escalateCount": <number>
}`;

/**
 * Consensus analyzer — aggregates findings from three reviewers.
 * Uses `frontier` tier per PIPELINE_MODEL_MAP.
 *
 * Requests structured JSON output from the LLM and parses it directly,
 * using the `agreedCount`/`contestedCount`/`escalateCount` from the
 * response instead of re-counting.
 */
export async function aggregateConsensus(
  input: {
    logic: ReviewFinding[];
    risk: ReviewFinding[];
    consistency: ReviewFinding[];
  },
  llm: LLMClient,
): Promise<ConsensusResult> {
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
  ].join('\n');

  const result = await requestStructured<{
    findings?: unknown[];
    agreedCount?: unknown;
    contestedCount?: unknown;
    escalateCount?: unknown;
  }>(
    llm,
    'frontier',
    systemPrompt,
    userPrompt,
    CONSENSUS_SCHEMA,
  );

  const rawFindings = Array.isArray(result.findings) ? result.findings : [];

  const findings: ConsensusFinding[] = rawFindings.map((f: any) => {
    const statusRaw = String(f.status ?? 'disputed').toLowerCase();
    const status: ConsensusFinding['status'] =
      statusRaw === 'agreed' ? 'agreed'
      : statusRaw === 'dismissed' ? 'dismissed'
      : 'disputed';

    const confidence = Number(f.confidence ?? 0.5);
    const escalate = Boolean(f.escalate) || confidence < 0.8;

    const sources = Array.isArray(f.sources)
      ? f.sources.map((s: any) => String(s))
      : [];
    const locations = Array.isArray(f.locations)
      ? f.locations.map((l: any) => String(l))
      : [];

    // Generate a stable ID from issue text + locations
    const idInput = `${String(f.issue ?? '')}|${locations.join(',')}`;
    const id = createHash('sha256').update(idInput).digest('hex').slice(0, 12);

    return {
      id,
      status,
      issue: String(f.issue ?? ''),
      sources,
      locations,
      confidence,
      escalate,
      reason: String(f.reason ?? ''),
    };
  });

  // Use the counts from the LLM response directly when available;
  // fall back to local counting for robustness.
  const agreedCount = typeof result.agreedCount === 'number'
    ? result.agreedCount
    : findings.filter(f => f.status === 'agreed').length;
  const contestedCount = typeof result.contestedCount === 'number'
    ? result.contestedCount
    : findings.filter(f => f.status === 'disputed').length;
  const escalateCount = typeof result.escalateCount === 'number'
    ? result.escalateCount
    : findings.filter(f => f.escalate).length;

  return { findings, agreedCount, contestedCount, escalateCount };
}
