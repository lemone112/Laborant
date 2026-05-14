/**
 * @module pipeline/activities
 * @description Temporal activity implementations for Laborant.
 *
 * Each activity creates its own LLMClient + BudgetTracker internally
 * (Temporal activities must be serialisable — no non-serialisable params).
 */

import type { PipelineContext, BuildContextInput } from './context-assembly/builder.js';
import type {
  ReviewFinding,
  ConsensusFinding,
  CoVeVerdict,
  LandscapeArtifact,
  ReviewOutput,
} from '../config/defaults.js';
import type { ConsensusResult } from './consensus/aggregator.js';

export interface ActivityBudgetMeta {
  llmCalls: number;
  costUSD: number;
}

/** Proper wrapper type for activity results — avoids Array & Object intersection */
export interface ActivityResult<T> {
  data: T;
  budget: ActivityBudgetMeta;
}

async function createFreshLLM(maxCalls?: number, maxCostUSD?: number) {
  const { createBudgetTracker } = await import('../llm/budget.js');
  const { createLLMClient } = await import('../llm/client.js');
  const budget = createBudgetTracker({
    maxCalls: maxCalls ?? 25,
    maxCostUSD: maxCostUSD ?? 0.50,
  });
  const llm = createLLMClient(budget);
  return { llm, budget };
}

function budgetMeta(budget: { getStats(): { totalCalls: number; totalCostUSD: number } }): ActivityBudgetMeta {
  const stats = budget.getStats();
  return { llmCalls: stats.totalCalls, costUSD: stats.totalCostUSD };
}

// ── Context Assembly ──

export async function buildContextActivity(
  input: BuildContextInput & { budgetRemainingCalls: number; budgetRemainingCostUSD: number },
): Promise<ActivityResult<PipelineContext>> {
  const { llm, budget } = await createFreshLLM(input.budgetRemainingCalls, input.budgetRemainingCostUSD);
  const { buildContext } = await import('./context-assembly/builder.js');
  const context = await buildContext(input, llm, budget);
  return { data: context, budget: budgetMeta(budget) };
}

export async function buildLandscapeActivity(
  repoPath: string,
  diff: string,
): Promise<ActivityResult<LandscapeArtifact>> {
  const { llm, budget } = await createFreshLLM();
  const { buildContext } = await import('./context-assembly/builder.js');
  const context = await buildContext({ diff, changedFiles: [], repoPath }, llm, budget);
  return { data: context.landscape, budget: budgetMeta(budget) };
}

// ── Triple Review ──

export async function reviewLogicActivity(
  context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number },
): Promise<ActivityResult<ReviewFinding[]>> {
  const { llm, budget } = await createFreshLLM(context.budgetRemainingCalls, context.budgetRemainingCostUSD);
  const { reviewLogic } = await import('./triple-review/logic.js');
  const findings = await reviewLogic(context, llm);
  return { data: findings, budget: budgetMeta(budget) };
}

export async function reviewRiskActivity(
  context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number },
): Promise<ActivityResult<ReviewFinding[]>> {
  const { llm, budget } = await createFreshLLM(context.budgetRemainingCalls, context.budgetRemainingCostUSD);
  const { reviewRisk } = await import('./triple-review/risk.js');
  const findings = await reviewRisk(context, llm);
  return { data: findings, budget: budgetMeta(budget) };
}

export async function reviewConsistencyActivity(
  context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number },
): Promise<ActivityResult<ReviewFinding[]>> {
  const { llm, budget } = await createFreshLLM(context.budgetRemainingCalls, context.budgetRemainingCostUSD);
  const { reviewConsistency } = await import('./triple-review/consistency.js');
  const findings = await reviewConsistency(context, llm);
  return { data: findings, budget: budgetMeta(budget) };
}

// ── Consensus ──

export async function aggregateConsensusActivity(
  input: {
    logic: ReviewFinding[];
    risk: ReviewFinding[];
    consistency: ReviewFinding[];
    budgetRemainingCalls: number;
    budgetRemainingCostUSD: number;
  },
): Promise<ActivityResult<ConsensusResult>> {
  const { llm, budget } = await createFreshLLM(input.budgetRemainingCalls, input.budgetRemainingCostUSD);
  const { aggregateConsensus } = await import('./consensus/aggregator.js');
  const result = await aggregateConsensus(input, llm);
  return { data: result, budget: budgetMeta(budget) };
}

// ── CoVe ──

export async function runCoVeActivity(
  findings: ConsensusFinding[],
  context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number },
): Promise<ActivityResult<Record<string, CoVeVerdict>>> {
  const { llm, budget } = await createFreshLLM(context.budgetRemainingCalls, context.budgetRemainingCostUSD);
  const { runCoVe } = await import('./cove/verify.js');
  const result = await runCoVe(findings, context, llm, budget);
  return { data: result, budget: budgetMeta(budget) };
}

// ── Feedback Gate ──

export async function applyFeedbackGateActivity(
  findings: ConsensusFinding[],
  projectId: string,
): Promise<{ findings: ConsensusFinding[]; adjustedCount: number; matchedPatterns: string[] }> {
  const { applyFeedbackGate } = await import('./feedback-gate.js');
  return applyFeedbackGate(findings, projectId);
}

// ── Report ──

export async function formatReportActivity(
  verifiedFindings: ConsensusFinding[],
  coveResults: Record<string, CoVeVerdict>,
  landscape: LandscapeArtifact,
  budgetRemainingCalls: number,
  budgetRemainingCostUSD: number,
): Promise<ActivityResult<ReviewOutput>> {
  const { llm, budget } = await createFreshLLM(budgetRemainingCalls, budgetRemainingCostUSD);
  const { formatReport } = await import('./report/formatter.js');
  const output = await formatReport(verifiedFindings, coveResults, landscape, llm);
  return { data: output, budget: budgetMeta(budget) };
}
