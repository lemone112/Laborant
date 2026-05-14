/**
 * @module pipeline/cove/workflow
 * @description Simplified CoVe — single-step verification for escalated findings.
 *
 * Instead of the original 3-step chain (question-gen → verifier → verdict),
 * we use one LLM call that verifies the finding directly. This reduces cost
 * from 3 calls/finding to 1 call/finding while keeping the core benefit:
 * a second opinion on uncertain findings.
 */

import type { CoVeVerdict, ConsensusFinding } from '../../config/defaults.js';
import { env } from '../../config/env.js';
import type { LLMClient } from '../../llm/client.js';
import type { BudgetTracker } from '../../llm/budget.js';
import type { PipelineContext } from '../context-assembly/builder.js';
import { requestStructured } from '../../util/structured-output.js';
import { loadPrompt } from '../../util/prompts.js';

const VERIFY_SCHEMA = `{
  "verdict": "<confirmed|revised|rejected>",
  "reasoning": "<why>"
}`;

/**
 * Run simplified CoVe verification on escalated findings.
 */
export async function runCoVe(
  findings: ConsensusFinding[],
  context: PipelineContext,
  llm: LLMClient,
  budget: BudgetTracker,
): Promise<Record<string, CoVeVerdict>> {
  const results: Record<string, CoVeVerdict> = {};

  if (!env.PIPELINE_COVE_ENABLED) {
    return results;
  }

  const escalated = findings.filter(f => f.escalate);
  const limited = escalated.slice(0, env.PIPELINE_COVE_MAX_FINDINGS);

  for (const finding of limited) {
    try {
      budget.checkBudget();

      const systemPrompt = await loadPrompt('cove-verify');
      const userPrompt = [
        'Verify this finding independently.',
        '',
        `<finding>${JSON.stringify(finding)}</finding>`,
        `<diff>${context.diff.slice(0, 6000)}</diff>`,
        `<landscape>${JSON.stringify(context.landscape)}</landscape>`,
      ].join('\n');

      const result = await requestStructured<{ verdict?: string; reasoning?: string }>(
        llm,
        'base',
        systemPrompt,
        userPrompt,
        VERIFY_SCHEMA,
      );

      const verdictRaw = String(result.verdict ?? 'confirmed').toLowerCase();
      const verdict: CoVeVerdict['verdict'] =
        verdictRaw === 'rejected' ? 'rejected'
        : verdictRaw === 'revised' ? 'revised'
        : 'confirmed';

      results[finding.issue] = {
        findingId: finding.issue,
        verdict,
        reasoning: String(result.reasoning ?? ''),
      };
    } catch (error) {
      if (error instanceof Error && error.message.includes('Budget')) break;
      console.warn(`CoVe verify failed for "${finding.issue}":`, error);
    }
  }

  return results;
}
