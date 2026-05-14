/**
 * @module pipeline/activities
 * @description Temporal activity implementations for the AI Code Review pipeline.
 *
 * Each activity is a standalone async function that:
 * - Can be retried by Temporal based on retry policy
 * - Is time-limited via startToCloseTimeout
 * - Creates its own LLMClient and BudgetTracker internally
 * - Is fully serialisable (no non-serialisable parameters)
 * - Returns budget metadata so the workflow can track aggregate consumption
 *
 * ### Design: Self-Contained Activities with Budget Awareness
 *
 * Activities MUST NOT receive non-serialisable objects (LLMClient, BudgetTracker,
 * database connections) as parameters. Instead, each activity creates its own
 * instances internally. However, activities DO accept `budgetRemainingCalls` and
 * `budgetRemainingCostUSD` parameters so they can self-limit within the
 * workflow's overall budget.
 *
 * Each activity returns its budget consumption (`llmCalls`, `costUSD`) so the
 * workflow can aggregate totals across all activities.
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

// ── Budget metadata returned by every activity ──

/** Budget consumption metadata appended to every activity result. */
export interface ActivityBudgetMeta {
  /** Number of LLM calls made by this activity. */
  llmCalls: number;
  /** Estimated cost in USD of LLM calls in this activity. */
  costUSD: number;
}

// ── Helper: Create fresh LLM client per activity with budget limits ──

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

/** Extract budget stats from a BudgetTracker instance. */
function budgetMeta(budget: { getStats(): { totalCalls: number; totalCostUSD: number } }): ActivityBudgetMeta {
  const stats = budget.getStats();
  return { llmCalls: stats.totalCalls, costUSD: stats.totalCostUSD };
}

// ── Context Assembly Activities ────────────────────────────────────────────

/**
 * Build the full pipeline context: landscape scan, risk map, and similar-pattern search.
 *
 * @param input - The build context input (diff, changed files, repo path, budget remaining).
 * @returns A fully populated {@link PipelineContext} with budget metadata.
 */
export async function buildContextActivity(
  input: BuildContextInput & { budgetRemainingCalls: number; budgetRemainingCostUSD: number },
): Promise<PipelineContext & ActivityBudgetMeta> {
  const { llm, budget } = await createFreshLLM(input.budgetRemainingCalls, input.budgetRemainingCostUSD);
  const { buildContext } = await import('./context-assembly/builder.js');
  const context = await buildContext(input, llm, budget);
  return { ...context, ...budgetMeta(budget) };
}

/**
 * Run only the landscape scan portion of context assembly.
 *
 * @param repoPath - Absolute path to the repository root.
 * @param diff     - The raw unified diff of the merge request.
 * @returns A {@link LandscapeArtifact} with architectural context.
 */
export async function buildLandscapeActivity(
  repoPath: string,
  diff: string,
): Promise<LandscapeArtifact & ActivityBudgetMeta> {
  const { llm, budget } = await createFreshLLM();
  const { buildContext } = await import('./context-assembly/builder.js');
  const context = await buildContext({ diff, changedFiles: [], repoPath }, llm, budget);
  return { ...context.landscape, ...budgetMeta(budget) };
}

// ── Triple Review Activities ───────────────────────────────────────────────

/**
 * Logic review activity — finds correctness issues in changed code.
 * Uses the `frontier` LLM tier (highest judgement required).
 *
 * @param context - The assembled pipeline context with budget remaining info.
 * @returns An array of logic/correctness findings with budget metadata.
 */
export async function reviewLogicActivity(
  context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number },
): Promise<ReviewFinding[] & ActivityBudgetMeta> {
  const { llm, budget } = await createFreshLLM(context.budgetRemainingCalls, context.budgetRemainingCostUSD);
  const { reviewLogic } = await import('./triple-review/logic.js');
  const findings = await reviewLogic(context, llm);
  const meta = budgetMeta(budget);
  return Object.assign(findings, meta);
}

/**
 * Risk review activity — finds breakage in modules indirectly affected by the change.
 * Uses the `frontier` LLM tier.
 *
 * @param context - The assembled pipeline context with budget remaining info.
 * @returns An array of risk-propagation findings with budget metadata.
 */
export async function reviewRiskActivity(
  context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number },
): Promise<ReviewFinding[] & ActivityBudgetMeta> {
  const { llm, budget } = await createFreshLLM(context.budgetRemainingCalls, context.budgetRemainingCostUSD);
  const { reviewRisk } = await import('./triple-review/risk.js');
  const findings = await reviewRisk(context, llm);
  const meta = budgetMeta(budget);
  return Object.assign(findings, meta);
}

/**
 * Consistency review activity — finds deviations from established patterns.
 * Uses the `base` LLM tier.
 *
 * @param context - The assembled pipeline context with budget remaining info.
 * @returns An array of consistency-deviation findings with budget metadata.
 */
export async function reviewConsistencyActivity(
  context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number },
): Promise<ReviewFinding[] & ActivityBudgetMeta> {
  const { llm, budget } = await createFreshLLM(context.budgetRemainingCalls, context.budgetRemainingCostUSD);
  const { reviewConsistency } = await import('./triple-review/consistency.js');
  const findings = await reviewConsistency(context, llm);
  const meta = budgetMeta(budget);
  return Object.assign(findings, meta);
}

// ── Consensus Activity ─────────────────────────────────────────────────────

/**
 * Consensus aggregation activity — reconciles the three review branches.
 * Uses the `frontier` LLM tier.
 *
 * @param input - The three sets of review findings to reconcile, plus budget remaining.
 * @returns A {@link ConsensusResult} with aggregated findings and budget metadata.
 */
export async function aggregateConsensusActivity(
  input: {
    logic: ReviewFinding[];
    risk: ReviewFinding[];
    consistency: ReviewFinding[];
    budgetRemainingCalls: number;
    budgetRemainingCostUSD: number;
  },
): Promise<ConsensusResult & ActivityBudgetMeta> {
  const { llm, budget } = await createFreshLLM(input.budgetRemainingCalls, input.budgetRemainingCostUSD);
  const { aggregateConsensus } = await import('./consensus/aggregator.js');
  const result = await aggregateConsensus(input, llm);
  return { ...result, ...budgetMeta(budget) };
}

// ── Feedback Gate Activity ─────────────────────────────────────────────────

/**
 * Apply feedback-based adjustments to consensus findings.
 * Lowers confidence for patterns previously dismissed by humans.
 *
 * @param findings  - Consensus findings to adjust.
 * @param projectId - The project ID to look up feedback for.
 * @returns Adjusted findings and adjustment metadata.
 */
export async function applyFeedbackGateActivity(
  findings: ConsensusFinding[],
  projectId: string,
): Promise<{ findings: ConsensusFinding[]; adjustedCount: number }> {
  const { applyFeedbackGate } = await import('./feedback-gate.js');
  const result = await applyFeedbackGate(findings, projectId);
  return { findings: result.findings, adjustedCount: result.adjustedCount };
}

// ── CoVe Activities ────────────────────────────────────────────────────────

/**
 * Chain-of-Verification (CoVe) activity.
 *
 * Runs verification only for escalated findings. Respects
 * PIPELINE_COVE_ENABLED and PIPELINE_COVE_MAX_FINDINGS env vars.
 * CoVe failure is **non-fatal**.
 *
 * @param findings - Consensus findings to verify.
 * @param context  - The assembled pipeline context with budget remaining info.
 * @returns A Record mapping finding issue text to its {@link CoVeVerdict}, plus budget metadata.
 */
export async function runCoVeActivity(
  findings: ConsensusFinding[],
  context: PipelineContext & { budgetRemainingCalls: number; budgetRemainingCostUSD: number },
): Promise<Record<string, CoVeVerdict> & ActivityBudgetMeta> {
  const { llm, budget } = await createFreshLLM(context.budgetRemainingCalls, context.budgetRemainingCostUSD);
  const { runCoVe } = await import('./cove/workflow.js');
  const result = await runCoVe(findings, context, llm, budget);
  const meta = budgetMeta(budget);
  return Object.assign(result, meta);
}

// ── Report Activity ────────────────────────────────────────────────────────

/**
 * Report formatting activity — transforms verified findings into the final review output.
 * Uses the `base` LLM tier.
 *
 * @param verifiedFindings - Consensus findings after CoVe verification.
 * @param coveResults      - CoVe verdicts keyed by finding issue text.
 * @param landscape        - The repository landscape artifact for context.
 * @param budgetRemainingCalls - Remaining LLM call budget.
 * @param budgetRemainingCostUSD - Remaining cost budget.
 * @returns The final {@link ReviewOutput} with inline comments, summary, and budget metadata.
 */
export async function formatReportActivity(
  verifiedFindings: ConsensusFinding[],
  coveResults: Record<string, CoVeVerdict>,
  landscape: LandscapeArtifact,
  budgetRemainingCalls: number,
  budgetRemainingCostUSD: number,
): Promise<ReviewOutput & ActivityBudgetMeta> {
  const { llm, budget } = await createFreshLLM(budgetRemainingCalls, budgetRemainingCostUSD);
  const { formatReport } = await import('./report/formatter.js');
  const output = await formatReport(verifiedFindings, coveResults, landscape, llm);
  return { ...output, ...budgetMeta(budget) };
}
