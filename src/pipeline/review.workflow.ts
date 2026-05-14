/**
 * @module pipeline/review.workflow
 * @description Temporal workflow definition for the AI Code Review pipeline.
 *
 * This file exports TWO things:
 * 1. **reviewWorkflow** — a proper Temporal workflow that uses `proxyActivities`
 *    to orchestrate the pipeline stages through Temporal's durability guarantees.
 *    This workflow is deterministic and safe for Temporal's sandboxed execution.
 *
 * 2. **runReviewPipeline** — a convenience function for direct (non-Temporal)
 *    execution. Useful for local development, testing, and the MCP server.
 *
 * ### Temporal Workflow Constraints
 * - Workflows MUST be deterministic: no `Date.now()`, `Math.random()`, network calls.
 * - All side effects (LLM calls, DB queries) MUST go through activities.
 * - Non-serializable objects (LLMClient, BudgetTracker) cannot pass through
 *   Temporal's data converter. Activities create their own instances internally.
 */

import { proxyActivities, log } from '@temporalio/workflow';
import type { ConsensusResult } from './consensus/aggregator.js';
import type {
  CoVeVerdict,
  ConsensusFinding,
  LandscapeArtifact,
  ReviewFinding,
  ReviewOutput,
  RiskMapEntry,
} from '../config/defaults.js';
import type { PipelineContext, BuildContextInput } from './context-assembly/builder.js';

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
  landscape: LandscapeArtifact | null;
  riskMap: RiskMapEntry[] | null;
  consensus: ConsensusResult | null;
  coveResults: Record<string, CoVeVerdict> | null;
  error?: string;
}

// ── Activity Interface ──
// These MUST match the signatures in activities.ts (without LLMClient/BudgetTracker params)

interface ReviewActivities {
  buildContextActivity(input: BuildContextInput): Promise<PipelineContext>;
  reviewLogicActivity(context: PipelineContext): Promise<ReviewFinding[]>;
  reviewRiskActivity(context: PipelineContext): Promise<ReviewFinding[]>;
  reviewConsistencyActivity(context: PipelineContext): Promise<ReviewFinding[]>;
  aggregateConsensusActivity(input: {
    logic: ReviewFinding[];
    risk: ReviewFinding[];
    consistency: ReviewFinding[];
  }): Promise<ConsensusResult>;
  applyFeedbackGateActivity(findings: ConsensusFinding[], projectId: string): Promise<{
    findings: ConsensusFinding[];
    adjustedCount: number;
  }>;
  runCoVeActivity(findings: ConsensusFinding[], context: PipelineContext): Promise<Record<string, CoVeVerdict>>;
  formatReportActivity(
    verifiedFindings: ConsensusFinding[],
    coveResults: Record<string, CoVeVerdict>,
    landscape: LandscapeArtifact,
  ): Promise<ReviewOutput>;
}

// ── Activity Proxy ──

const {
  buildContextActivity,
  reviewLogicActivity,
  reviewRiskActivity,
  reviewConsistencyActivity,
  aggregateConsensusActivity,
  applyFeedbackGateActivity,
  runCoVeActivity,
  formatReportActivity,
} = proxyActivities<ReviewActivities>({
  startToCloseTimeout: '5 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: ['BudgetExceededError', 'ApplicationError'],
  },
});

// ── Temporal Workflow ──

/**
 * Temporal workflow for AI Code Review.
 *
 * Orchestrates the full pipeline through activities, providing:
 * - Automatic retries on transient failures
 * - Durability — workflow survives worker restarts
 * - Observability via Temporal Web UI
 *
 * ### Execution Flow
 * ```
 * buildContext → [reviewLogic ∥ reviewRisk ∥ reviewConsistency]
 *     → aggregateConsensus → applyFeedbackGate → [runCoVe?]
 *     → formatReport
 * ```
 *
 * Note: Temporal does NOT support `Promise.all` for parallel activity
 * execution in the same way — activities are scheduled sequentially
 * unless using `Promise.all` which Temporal does support for determinism.
 */
export async function reviewWorkflow(input: ReviewWorkflowInput): Promise<ReviewWorkflowResult> {
  log.info('Starting review workflow', { projectId: input.projectId, mrIid: input.mrIid });

  try {
    // ── Step 1: Context Assembly ──
    const context = await buildContextActivity({
      diff: input.diff,
      changedFiles: input.changedFiles,
      repoPath: input.repoPath ?? process.cwd(),
    });

    // ── Step 2: Triple Review (parallel) ──
    const [logic, risk, consistency] = await Promise.all([
      reviewLogicActivity(context),
      reviewRiskActivity(context),
      reviewConsistencyActivity(context),
    ]);

    // ── Step 3: Consensus ──
    const consensus = await aggregateConsensusActivity({ logic, risk, consistency });

    // ── Step 4: Feedback Gate ──
    let gatedFindings = consensus.findings;
    let escalateCount = consensus.escalateCount;
    try {
      const feedbackResult = await applyFeedbackGateActivity(consensus.findings, input.projectId);
      gatedFindings = feedbackResult.findings;
      escalateCount = consensus.escalateCount - feedbackResult.adjustedCount;
      log.info('Feedback gate applied', { adjustedCount: feedbackResult.adjustedCount });
    } catch (err) {
      log.warn('Feedback gate failed (non-fatal)', { error: String(err) });
    }

    // ── Step 5: CoVe (only for escalated findings) ──
    let coveResults: Record<string, CoVeVerdict> = {};
    if (escalateCount > 0) {
      try {
        coveResults = await runCoVeActivity(gatedFindings, context);
      } catch (err) {
        log.warn('CoVe failed (non-fatal)', { error: String(err) });
      }
    }

    // ── Step 6: Report ──
    const output = await formatReportActivity(gatedFindings, coveResults, context.landscape);

    return {
      success: true,
      output,
      landscape: context.landscape,
      riskMap: context.riskMap,
      consensus: { ...consensus, findings: gatedFindings, escalateCount },
      coveResults,
    };
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    log.error('Review workflow failed', { error: message });
    return {
      success: false,
      output: null,
      landscape: null,
      riskMap: null,
      consensus: null,
      coveResults: null,
      error: message,
    };
  }
}

// ── Direct Execution Helper (non-Temporal) ──

/**
 * Run the review pipeline directly (without Temporal).
 *
 * This is the primary entry point when NOT using Temporal orchestration.
 * It creates its own LLMClient and BudgetTracker instances.
 * Used by the MCP server, manual trigger endpoint, and local development.
 */
export async function runReviewPipeline(
  input: ReviewWorkflowInput,
): Promise<{
  success: boolean;
  output: ReviewOutput | null;
  context: PipelineContext | null;
  consensus: ConsensusResult | null;
  coveResults: Record<string, CoVeVerdict> | null;
  budgetStats: { totalCalls: number; totalTokens: number; totalCostUSD: number };
  error?: string;
}> {
  // Dynamic imports to avoid pulling non-deterministic code into Temporal sandbox
  const { createBudgetTracker } = await import('../llm/budget.js');
  const { createLLMClient } = await import('../llm/client.js');
  const { buildContext } = await import('./context-assembly/builder.js');
  const { reviewLogic } = await import('./triple-review/logic.js');
  const { reviewRisk } = await import('./triple-review/risk.js');
  const { reviewConsistency } = await import('./triple-review/consistency.js');
  const { aggregateConsensus } = await import('./consensus/aggregator.js');
  const { applyFeedbackGate } = await import('./feedback-gate.js');
  const { runCoVe } = await import('./cove/workflow.js');
  const { formatReport } = await import('./report/formatter.js');
  const { env } = await import('../config/env.js');

  const budget = createBudgetTracker();
  const llm = createLLMClient(budget);

  try {
    // ── Layer 1: Context Assembly ──
    const context = await buildContext({
      diff: input.diff,
      changedFiles: input.changedFiles,
      repoPath: input.repoPath ?? process.cwd(),
    }, llm, budget);

    budget.checkBudget();

    // ── Layer 2: Triple Review (parallel) ──
    const [logic, risk, consistency] = await Promise.all([
      reviewLogic(context, llm),
      reviewRisk(context, llm),
      reviewConsistency(context, llm),
    ]);

    // ── Consensus ──
    const consensus = await aggregateConsensus({ logic, risk, consistency }, llm);

    // ── Feedback Gate ──
    let gatedConsensus = consensus;
    try {
      const feedbackResult = await applyFeedbackGate(consensus.findings, input.projectId);
      gatedConsensus = {
        ...consensus,
        findings: feedbackResult.findings,
        escalateCount: consensus.escalateCount - feedbackResult.adjustedCount,
      };
    } catch (err) {
      console.warn('[pipeline] Feedback gate failed (non-fatal):', err instanceof Error ? err.message : String(err));
    }

    // ── Layer 3: CoVe (only for ESCALATE findings) ──
    let coveResults: Record<string, CoVeVerdict> | null = null;
    if (gatedConsensus.escalateCount > 0 && env.PIPELINE_COVE_ENABLED) {
      coveResults = await runCoVe(gatedConsensus.findings, context, llm, budget);
    }

    // ── Layer 4: Report ──
    const output = await formatReport(
      gatedConsensus.findings,
      coveResults ?? {},
      context.landscape,
      llm,
    );

    return {
      success: true,
      output,
      context,
      consensus: gatedConsensus,
      coveResults,
      budgetStats: budget.getStats(),
    };
  } catch (error) {
    return {
      success: false,
      output: null,
      context: null,
      consensus: null,
      coveResults: null,
      budgetStats: budget.getStats(),
      error: error instanceof Error ? error.message : String(error),
    };
  }
}
