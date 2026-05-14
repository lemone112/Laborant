import type { CoVeVerdict, ConsensusFinding } from '../../config/defaults.js';
import { env } from '../../config/env.js';
import { budgetTracker } from '../../llm/budget.js';
import type { PipelineContext } from '../context-assembly/builder.js';
import { generateQuestions } from './question-generator.js';
import { verifyQuestions } from './verifier.js';
import { renderVerdict } from './verdict.js';

/**
 * CoVe sub-workflow — runs verification only for ESCALATE findings.
 * Respects PIPELINE_COVE_ENABLED and PIPELINE_COVE_MAX_FINDINGS.
 */
export async function runCoVe(
  findings: ConsensusFinding[],
  context: PipelineContext,
): Promise<Map<string, CoVeVerdict>> {
  const results = new Map<string, CoVeVerdict>();

  if (!env.PIPELINE_COVE_ENABLED) {
    return results;
  }

  const escalated = findings.filter(f => f.escalate);
  const limited = escalated.slice(0, env.PIPELINE_COVE_MAX_FINDINGS);

  for (const finding of limited) {
    try {
      budgetTracker.checkBudget();

      // Step A: Generate verification questions
      const questions = await generateQuestions(
        finding,
        context.diff,
        context.landscape,
      );

      if (questions.length === 0) continue;

      // Step B: Independent verification
      const answers = await verifyQuestions(
        questions,
        context.diff,
        context.landscape,
      );

      // Step C: Render verdict
      const verdict = await renderVerdict(
        finding,
        questions,
        answers,
        context.diff,
      );

      results.set(finding.issue, verdict);
    } catch (error) {
      // Budget exceeded or LLM failure — skip remaining CoVe
      if (error instanceof Error && error.message.includes('Budget')) break;
      console.error(`CoVe failed for finding "${finding.issue}":`, error);
    }
  }

  return results;
}
