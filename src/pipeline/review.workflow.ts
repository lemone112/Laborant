import type { ConsensusResult } from './consensus/aggregator.js';
import type { ReviewOutput } from '../config/defaults.js';
import { env } from '../config/env.js';
import { budgetTracker } from '../llm/budget.js';
import { buildContext, type PipelineContext } from './context-assembly/builder.js';
import { reviewLogic } from './triple-review/logic.js';
import { reviewRisk } from './triple-review/risk.js';
import { reviewConsistency } from './triple-review/consistency.js';
import { aggregateConsensus } from './consensus/aggregator.js';
import { runCoVe } from './cove/workflow.js';
import { formatReport } from './report/formatter.js';

// ── Types ──

export interface ReviewWorkflowInput {
  mrIid: number;
  projectId: string;
  diff: string;
  changedFiles: string[];
  repoPath?: string;
}

export interface ReviewWorkflowResult {
  success: boolean;
  output: ReviewOutput | null;
  context: PipelineContext | null;
  consensus: ConsensusResult | null;
  coveResults: Map<string, any> | null;
  budgetStats: ReturnType<typeof budgetTracker.getStats>;
  error?: string;
}

// ── Main Pipeline ──

/**
 * Main review pipeline — orchestrates all stages.
 * Designed to be called from Temporal workflow or directly.
 */
export async function runReviewPipeline(
  input: ReviewWorkflowInput,
): Promise<ReviewWorkflowResult> {
  budgetTracker.reset();

  try {
    // ── Layer 1: Context Assembly ──
    const context = await buildContext({
      diff: input.diff,
      changedFiles: input.changedFiles,
      repoPath: input.repoPath ?? process.cwd(),
    });

    // Budget gate
    budgetTracker.checkBudget();

    // ── Layer 2: Triple Review (parallel) ──
    const [logic, risk, consistency] = await Promise.all([
      reviewLogic(context),
      reviewRisk(context),
      reviewConsistency(context),
    ]);

    // ── Consensus ──
    const consensus = await aggregateConsensus({ logic, risk, consistency });

    // ── Layer 3: CoVe (only for ESCALATE findings) ──
    let coveResults: Map<string, any> | null = null;
    if (consensus.escalateCount > 0 && env.PIPELINE_COVE_ENABLED) {
      coveResults = await runCoVe(consensus.findings, context);
    }

    // ── Layer 4: Report ──
    const output = await formatReport(
      consensus.findings,
      coveResults ?? new Map(),
      context.landscape,
    );

    return {
      success: true,
      output,
      context,
      consensus,
      coveResults,
      budgetStats: budgetTracker.getStats(),
    };
  } catch (error) {
    return {
      success: false,
      output: null,
      context: null,
      consensus: null,
      coveResults: null,
      budgetStats: budgetTracker.getStats(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
