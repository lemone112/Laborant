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
  /** Total LLM calls consumed across all activities. */
  totalLLMCalls: number;
  /** Estimated total cost in USD across all activities. */
  totalCostUSD: number;
  error?: string;
}

// ── Activity Interface ──
// These MUST match the signatures in activities.ts (without LLMClient/BudgetTracker params)
//
// IMPORTANT: Budget tracking strategy.
// Each activity runs in its own process and creates its own BudgetTracker.
// To enforce a per-pipeline budget, activities accept a `budgetRemaining` parameter
// so they can self-limit. The workflow aggregates call counts from activity results
// to track total consumption.

/** Result wrapper that includes budget usage metadata. */
interface ActivityBudgetMeta {
  /** Number of LLM calls made by this activity. */
  llmCalls: number;
  /** Estimated cost in USD of LLM calls in this activity. */
  costUSD: number;
}

interface ReviewActivities {
  buildContextActivity(input: BuildContextInput & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<PipelineContext & ActivityBudgetMeta>;
  reviewLogicActivity(context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<(ReviewFinding[]) & ActivityBudgetMeta>;
  reviewRiskActivity(context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<(ReviewFinding[]) & ActivityBudgetMeta>;
  reviewConsistencyActivity(context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<(ReviewFinding[]) & ActivityBudgetMeta>;
  aggregateConsensusActivity(input: {
    logic: ReviewFinding[];
    risk: ReviewFinding[];
    consistency: ReviewFinding[];
    budgetRemainingCalls: number;
    budgetRemainingCostUSD: number;
  }): Promise<ConsensusResult & ActivityBudgetMeta>;
  applyFeedbackGateActivity(findings: ConsensusFinding[], projectId: string): Promise<{
    findings: ConsensusFinding[];
    adjustedCount: number;
  }>;
  runCoVeActivity(findings: ConsensusFinding[], context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<Record<string, CoVeVerdict> & ActivityBudgetMeta>;
  formatReportActivity(
    verifiedFindings: ConsensusFinding[],
    coveResults: Record<string, CoVeVerdict>,
    landscape: LandscapeArtifact,
    budgetRemainingCalls: number,
    budgetRemainingCostUSD: number,
  ): Promise<ReviewOutput & ActivityBudgetMeta>;
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
    // ── Budget tracking ──
    // The workflow tracks aggregate budget. Each activity receives
    // the remaining budget so it can self-limit.
    let totalCalls = 0;
    let totalCostUSD = 0;
    const maxCalls = 25; // PIPELINE_MAX_LLM_CALLS default
    const maxCostUSD = 0.50; // PIPELINE_MAX_COST_USD default

    const remainingCalls = () => Math.max(0, maxCalls - totalCalls);
    const remainingCost = () => Math.max(0, maxCostUSD - totalCostUSD);

    // ── Step 1: Context Assembly ──
    // NOTE: repoPath is required — do NOT use process.cwd() here.
    // Temporal workflows must be deterministic; process.cwd() is non-deterministic.
    const repoPath = input.repoPath;
    if (!repoPath) {
      throw new Error('repoPath is required for the review workflow');
    }

    const context = await buildContextActivity({
      diff: input.diff,
      changedFiles: input.changedFiles,
      repoPath,
      budgetRemainingCalls: remainingCalls(),
      budgetRemainingCostUSD: remainingCost(),
    });
    totalCalls += context.llmCalls;
    totalCostUSD += context.costUSD;
    log.info('Context assembly complete', { calls: context.llmCalls, cost: context.costUSD, totalCalls, totalCostUSD });

    // ── Step 2: Triple Review (parallel) ──
    const contextWithBudget = { ...context, budgetRemainingCalls: remainingCalls(), budgetRemainingCostUSD: remainingCost() };
    const [logicResult, riskResult, consistencyResult] = await Promise.all([
      reviewLogicActivity(contextWithBudget),
      reviewRiskActivity(contextWithBudget),
      reviewConsistencyActivity(contextWithBudget),
    ]);
    totalCalls += (logicResult.llmCalls ?? 0) + (riskResult.llmCalls ?? 0) + (consistencyResult.llmCalls ?? 0);
    totalCostUSD += (logicResult.costUSD ?? 0) + (riskResult.costUSD ?? 0) + (consistencyResult.costUSD ?? 0);
    log.info('Triple review complete', { totalCalls, totalCostUSD });

    // Extract findings from results (they may have budget metadata attached)
    const logic = Array.isArray(logicResult) ? logicResult : (logicResult as any).findings ?? logicResult;
    const risk = Array.isArray(riskResult) ? riskResult : (riskResult as any).findings ?? riskResult;
    const consistency = Array.isArray(consistencyResult) ? consistencyResult : (consistencyResult as any).findings ?? consistencyResult;

    // ── Step 3: Consensus ──
    const consensus = await aggregateConsensusActivity({
      logic,
      risk,
      consistency,
      budgetRemainingCalls: remainingCalls(),
      budgetRemainingCostUSD: remainingCost(),
    });
    totalCalls += consensus.llmCalls ?? 0;
    totalCostUSD += consensus.costUSD ?? 0;

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
        const coveContext = { ...context, budgetRemainingCalls: remainingCalls(), budgetRemainingCostUSD: remainingCost() };
        const coveResult = await runCoVeActivity(gatedFindings, coveContext);
        coveResults = coveResult;
        totalCalls += (coveResult as any).llmCalls ?? 0;
        totalCostUSD += (coveResult as any).costUSD ?? 0;
      } catch (err) {
        log.warn('CoVe failed (non-fatal)', { error: String(err) });
      }
    }

    // ── Step 6: Report ──
    const output = await formatReportActivity(
      gatedFindings, coveResults, context.landscape,
      remainingCalls(), remainingCost(),
    );
    totalCalls += output.llmCalls ?? 0;
    totalCostUSD += output.costUSD ?? 0;

    return {
      success: true,
      output,
      landscape: context.landscape,
      riskMap: context.riskMap,
      consensus: { ...consensus, findings: gatedFindings, escalateCount },
      coveResults,
      totalLLMCalls: totalCalls,
      totalCostUSD,
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
      totalLLMCalls: 0,
      totalCostUSD: 0,
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
