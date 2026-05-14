/**
 * @module pipeline/review.workflow
 * @description Temporal workflow + direct-execution helper for the Laborant pipeline.
 *
 * Two modes:
 * 1. **reviewWorkflow** — Temporal workflow with durability, retries, observability.
 * 2. **runReviewPipeline** — Direct execution for MCP server, CLI, local dev.
 *
 * Pipeline: Context Assembly → [Triple Review?] → Consensus → [CoVe?] → Report
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
  totalLLMCalls: number;
  totalCostUSD: number;
  error?: string;
}

// ── Activity budget metadata ──

interface ActivityBudgetMeta {
  llmCalls: number;
  costUSD: number;
}

interface ReviewActivities {
  buildContextActivity(input: BuildContextInput & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<PipelineContext & ActivityBudgetMeta>;
  reviewLogicActivity(context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<ReviewFinding[] & ActivityBudgetMeta>;
  reviewRiskActivity(context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<ReviewFinding[] & ActivityBudgetMeta>;
  reviewConsistencyActivity(context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<ReviewFinding[] & ActivityBudgetMeta>;
  aggregateConsensusActivity(input: {
    logic: ReviewFinding[];
    risk: ReviewFinding[];
    consistency: ReviewFinding[];
    budgetRemainingCalls: number;
    budgetRemainingCostUSD: number;
  }): Promise<ConsensusResult & ActivityBudgetMeta>;
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

export async function reviewWorkflow(input: ReviewWorkflowInput): Promise<ReviewWorkflowResult> {
  log.info('Starting review workflow', { projectId: input.projectId, mrIid: input.mrIid });

  try {
    let totalCalls = 0;
    let totalCostUSD = 0;
    const maxCalls = 25;
    const maxCostUSD = 0.50;
    const remainingCalls = () => Math.max(0, maxCalls - totalCalls);
    const remainingCost = () => Math.max(0, maxCostUSD - totalCostUSD);

    const repoPath = input.repoPath;
    if (!repoPath) {
      throw new Error('repoPath is required for the review workflow');
    }

    // ── Step 1: Context Assembly ──
    const context = await buildContextActivity({
      diff: input.diff,
      changedFiles: input.changedFiles,
      repoPath,
      budgetRemainingCalls: remainingCalls(),
      budgetRemainingCostUSD: remainingCost(),
    });
    totalCalls += context.llmCalls;
    totalCostUSD += context.costUSD;

    // ── Step 2: Triple Review (parallel) ──
    const contextWithBudget = { ...context, budgetRemainingCalls: remainingCalls(), budgetRemainingCostUSD: remainingCost() };
    const [logicResult, riskResult, consistencyResult] = await Promise.all([
      reviewLogicActivity(contextWithBudget),
      reviewRiskActivity(contextWithBudget),
      reviewConsistencyActivity(contextWithBudget),
    ]);
    totalCalls += (logicResult.llmCalls ?? 0) + (riskResult.llmCalls ?? 0) + (consistencyResult.llmCalls ?? 0);
    totalCostUSD += (logicResult.costUSD ?? 0) + (riskResult.costUSD ?? 0) + (consistencyResult.costUSD ?? 0);

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

    // ── Step 4: CoVe (escalated only) ──
    let coveResults: Record<string, CoVeVerdict> = {};
    if (consensus.escalateCount > 0) {
      try {
        const coveContext = { ...context, budgetRemainingCalls: remainingCalls(), budgetRemainingCostUSD: remainingCost() };
        const coveResult = await runCoVeActivity(consensus.findings, coveContext);
        coveResults = coveResult;
        totalCalls += (coveResult as any).llmCalls ?? 0;
        totalCostUSD += (coveResult as any).costUSD ?? 0;
      } catch (err) {
        log.warn('CoVe failed (non-fatal)', { error: String(err) });
      }
    }

    // ── Step 5: Report ──
    const output = await formatReportActivity(
      consensus.findings, coveResults, context.landscape,
      remainingCalls(), remainingCost(),
    );
    totalCalls += output.llmCalls ?? 0;
    totalCostUSD += output.costUSD ?? 0;

    return {
      success: true,
      output,
      landscape: context.landscape,
      riskMap: context.riskMap,
      consensus,
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
  const { createBudgetTracker } = await import('../llm/budget.js');
  const { createLLMClient } = await import('../llm/client.js');
  const { buildContext } = await import('./context-assembly/builder.js');
  const { reviewLogic } = await import('./triple-review/logic.js');
  const { reviewRisk } = await import('./triple-review/risk.js');
  const { reviewConsistency } = await import('./triple-review/consistency.js');
  const { aggregateConsensus } = await import('./consensus/aggregator.js');
  const { runCoVe } = await import('./cove/workflow.js');
  const { formatReport } = await import('./report/formatter.js');
  const { env } = await import('../config/env.js');

  const budget = createBudgetTracker();
  const llm = createLLMClient(budget);

  try {
    // Context Assembly
    const context = await buildContext({
      diff: input.diff,
      changedFiles: input.changedFiles,
      repoPath: input.repoPath ?? process.cwd(),
    }, llm, budget);

    budget.checkBudget();

    // Triple Review (parallel)
    const [logic, risk, consistency] = await Promise.all([
      reviewLogic(context, llm),
      reviewRisk(context, llm),
      reviewConsistency(context, llm),
    ]);

    // Consensus
    const consensus = await aggregateConsensus({ logic, risk, consistency }, llm);

    // CoVe (escalated only)
    let coveResults: Record<string, CoVeVerdict> | null = null;
    if (consensus.escalateCount > 0 && env.PIPELINE_COVE_ENABLED) {
      coveResults = await runCoVe(consensus.findings, context, llm, budget);
    }

    // Report
    const output = await formatReport(
      consensus.findings,
      coveResults ?? {},
      context.landscape,
      llm,
    );

    return {
      success: true,
      output,
      context,
      consensus,
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
