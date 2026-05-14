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
import type { ActivityResult } from './activities.js';

// ── Types ──

export interface ReviewWorkflowInput {
  mrIid: number;
  projectId: string;
  diff: string;
  changedFiles: string[];
  repoPath?: string;
  /** Max LLM calls for this review (default from env) */
  maxLLMCalls?: number;
  /** Max cost in USD for this review (default from env) */
  maxCostUSD?: number;
  /** Whether triple review is enabled (default from env) */
  tripleReviewEnabled?: boolean;
  /** Whether CoVe verification is enabled (default from env) */
  coveEnabled?: boolean;
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

// ── Activity interface ──

interface ReviewActivities {
  buildContextActivity(input: BuildContextInput & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<ActivityResult<PipelineContext>>;
  reviewLogicActivity(context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<ActivityResult<ReviewFinding[]>>;
  reviewRiskActivity(context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<ActivityResult<ReviewFinding[]>>;
  reviewConsistencyActivity(context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<ActivityResult<ReviewFinding[]>>;
  aggregateConsensusActivity(input: {
    logic: ReviewFinding[];
    risk: ReviewFinding[];
    consistency: ReviewFinding[];
    budgetRemainingCalls: number;
    budgetRemainingCostUSD: number;
  }): Promise<ActivityResult<ConsensusResult>>;
  applyFeedbackGateActivity(findings: ConsensusFinding[], projectId: string): Promise<{ findings: ConsensusFinding[]; adjustedCount: number; matchedPatterns: string[] }>;
  runCoVeActivity(findings: ConsensusFinding[], context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number }): Promise<ActivityResult<Record<string, CoVeVerdict>>>;
  formatReportActivity(
    verifiedFindings: ConsensusFinding[],
    coveResults: Record<string, CoVeVerdict>,
    landscape: LandscapeArtifact,
    budgetRemainingCalls: number,
    budgetRemainingCostUSD: number,
  ): Promise<ActivityResult<ReviewOutput>>;
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

export async function reviewWorkflow(input: ReviewWorkflowInput): Promise<ReviewWorkflowResult> {
  log.info('Starting review workflow', { projectId: input.projectId, mrIid: input.mrIid });

  try {
    const maxCalls = input.maxLLMCalls ?? 25;
    const maxCostUSD = input.maxCostUSD ?? 0.50;
    const tripleReviewEnabled = input.tripleReviewEnabled ?? true;
    const coveEnabled = input.coveEnabled ?? true;

    let totalCalls = 0;
    let totalCostUSD = 0;
    const remainingCalls = () => Math.max(0, maxCalls - totalCalls);
    const remainingCost = () => Math.max(0, maxCostUSD - totalCostUSD);

    // repoPath MUST be provided by the caller — Temporal workflows must be deterministic
    // and cannot access process.cwd() or other non-deterministic APIs
    const repoPath = input.repoPath ?? '/repo';

    // ── Step 1: Context Assembly ──
    const contextResult = await buildContextActivity({
      diff: input.diff,
      changedFiles: input.changedFiles,
      repoPath,
      budgetRemainingCalls: remainingCalls(),
      budgetRemainingCostUSD: remainingCost(),
    });
    const context = contextResult.data;
    totalCalls += contextResult.budget.llmCalls;
    totalCostUSD += contextResult.budget.costUSD;

    // ── Step 2: Triple Review (parallel, budget split by 3) ──
    let logic: ReviewFinding[] = [];
    let risk: ReviewFinding[] = [];
    let consistency: ReviewFinding[] = [];

    if (tripleReviewEnabled) {
      // Split remaining budget evenly across 3 parallel activities to avoid 3x overspend
      const callsPerReview = Math.floor(remainingCalls() / 3);
      const costPerReview = remainingCost() / 3;

      const contextWithBudget = {
        ...context,
        budgetRemainingCalls: callsPerReview,
        budgetRemainingCostUSD: costPerReview,
      };
      const [logicResult, riskResult, consistencyResult] = await Promise.all([
        reviewLogicActivity(contextWithBudget),
        reviewRiskActivity(contextWithBudget),
        reviewConsistencyActivity(contextWithBudget),
      ]);
      logic = logicResult.data;
      risk = riskResult.data;
      consistency = consistencyResult.data;
      totalCalls += logicResult.budget.llmCalls + riskResult.budget.llmCalls + consistencyResult.budget.llmCalls;
      totalCostUSD += logicResult.budget.costUSD + riskResult.budget.costUSD + consistencyResult.budget.costUSD;
    }

    // ── Step 3: Consensus ──
    const consensusResult = await aggregateConsensusActivity({
      logic,
      risk,
      consistency,
      budgetRemainingCalls: remainingCalls(),
      budgetRemainingCostUSD: remainingCost(),
    });
    const consensus = consensusResult.data;
    totalCalls += consensusResult.budget.llmCalls;
    totalCostUSD += consensusResult.budget.costUSD;

    // ── Step 3.5: Feedback Gate ──
    try {
      const feedbackResult = await applyFeedbackGateActivity(consensus.findings, input.projectId);
      consensus.findings = feedbackResult.findings;
      consensus.escalateCount = feedbackResult.findings.filter(f => f.escalate).length;
    } catch (err) {
      log.warn('Feedback gate failed (non-fatal)', { error: String(err) });
    }

    // ── Step 4: CoVe (escalated only, when enabled) ──
    let coveResults: Record<string, CoVeVerdict> = {};
    if (consensus.escalateCount > 0 && coveEnabled) {
      try {
        const coveContext = { ...context, budgetRemainingCalls: remainingCalls(), budgetRemainingCostUSD: remainingCost() };
        const coveResult = await runCoVeActivity(consensus.findings, coveContext);
        coveResults = coveResult.data;
        totalCalls += coveResult.budget.llmCalls;
        totalCostUSD += coveResult.budget.costUSD;
      } catch (err) {
        log.warn('CoVe failed (non-fatal)', { error: String(err) });
      }
    }

    // ── Step 5: Report ──
    const reportResult = await formatReportActivity(
      consensus.findings, coveResults, context.landscape,
      remainingCalls(), remainingCost(),
    );
    const output = reportResult.data;
    totalCalls += reportResult.budget.llmCalls;
    totalCostUSD += reportResult.budget.costUSD;

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
  const { runCoVe } = await import('./cove/verify.js');
  const { formatReport } = await import('./report/formatter.js');
  const { env } = await import('../config/env.js');

  const budget = createBudgetTracker();
  const llm = createLLMClient(budget);

  const tripleReviewEnabled = input.tripleReviewEnabled ?? env.PIPELINE_TRIPLE_REVIEW;
  const coveEnabled = input.coveEnabled ?? env.PIPELINE_COVE_ENABLED;

  try {
    // Context Assembly
    const context = await buildContext({
      diff: input.diff,
      changedFiles: input.changedFiles,
      repoPath: input.repoPath ?? env.REPO_PATH_FALLBACK ?? process.cwd(),
    }, llm, budget);

    budget.checkBudget();

    // Triple Review (parallel)
    let logic: ReviewFinding[] = [];
    let risk: ReviewFinding[] = [];
    let consistency: ReviewFinding[] = [];

    if (tripleReviewEnabled) {
      [logic, risk, consistency] = await Promise.all([
        reviewLogic(context, llm),
        reviewRisk(context, llm),
        reviewConsistency(context, llm),
      ]);
    }

    // Consensus
    const consensus = await aggregateConsensus({ logic, risk, consistency }, llm);

    // Feedback gate
    const { applyFeedbackGate } = await import('./feedback-gate.js');
    const feedbackResult = await applyFeedbackGate(consensus.findings, input.projectId);
    consensus.findings = feedbackResult.findings;
    consensus.escalateCount = feedbackResult.findings.filter(f => f.escalate).length;

    // CoVe (escalated only)
    let coveResults: Record<string, CoVeVerdict> | null = null;
    if (consensus.escalateCount > 0 && coveEnabled) {
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
