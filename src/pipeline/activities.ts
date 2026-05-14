/**
 * @module pipeline/activities
 * @description Temporal activity implementations for the AI Code Review pipeline.
 *
 * Each activity is a standalone async function that:
 * - Can be retried by Temporal based on retry policy
 * - Is time-limited via startToCloseTimeout
 * - Creates its own LLMClient and BudgetTracker internally
 * - Is fully serialisable (no non-serialisable parameters)
 *
 * ### Design: Self-Contained Activities
 *
 * Activities MUST NOT receive non-serialisable objects (LLMClient, BudgetTracker,
 * database connections) as parameters. Instead, each activity creates its own
 * instances internally. This ensures:
 * 1. Temporal can serialise all activity inputs/outputs
 * 2. Activities are independently testable
 * 3. Each activity has a fresh budget tracker (no shared mutable state)
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

// ── Helper: Create fresh LLM client per activity ──

async function createFreshLLM() {
  const { createBudgetTracker } = await import('../llm/budget.js');
  const { createLLMClient } = await import('../llm/client.js');
  const budget = createBudgetTracker();
  const llm = createLLMClient(budget);
  return { llm, budget };
}

// ── Context Assembly Activities ────────────────────────────────────────────

/**
 * Build the full pipeline context: landscape scan, risk map, and similar-pattern search.
 *
 * @param input - The build context input (diff, changed files, repo path).
 * @returns A fully populated {@link PipelineContext}.
 */
export async function buildContextActivity(
  input: BuildContextInput,
): Promise<PipelineContext> {
  const { llm, budget } = await createFreshLLM();
  const { buildContext } = await import('./context-assembly/builder.js');
  return buildContext(input, llm, budget);
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
): Promise<LandscapeArtifact> {
  const { llm, budget } = await createFreshLLM();
  const { buildContext } = await import('./context-assembly/builder.js');
  const context = await buildContext({ diff, changedFiles: [], repoPath }, llm, budget);
  return context.landscape;
}

// ── Triple Review Activities ───────────────────────────────────────────────

/**
 * Logic review activity — finds correctness issues in changed code.
 * Uses the `frontier` LLM tier (highest judgement required).
 *
 * @param context - The assembled pipeline context.
 * @returns An array of logic/correctness findings.
 */
export async function reviewLogicActivity(
  context: PipelineContext,
): Promise<ReviewFinding[]> {
  const { llm } = await createFreshLLM();
  const { reviewLogic } = await import('./triple-review/logic.js');
  return reviewLogic(context, llm);
}

/**
 * Risk review activity — finds breakage in modules indirectly affected by the change.
 * Uses the `frontier` LLM tier.
 *
 * @param context - The assembled pipeline context.
 * @returns An array of risk-propagation findings.
 */
export async function reviewRiskActivity(
  context: PipelineContext,
): Promise<ReviewFinding[]> {
  const { llm } = await createFreshLLM();
  const { reviewRisk } = await import('./triple-review/risk.js');
  return reviewRisk(context, llm);
}

/**
 * Consistency review activity — finds deviations from established patterns.
 * Uses the `base` LLM tier.
 *
 * @param context - The assembled pipeline context.
 * @returns An array of consistency-deviation findings.
 */
export async function reviewConsistencyActivity(
  context: PipelineContext,
): Promise<ReviewFinding[]> {
  const { llm } = await createFreshLLM();
  const { reviewConsistency } = await import('./triple-review/consistency.js');
  return reviewConsistency(context, llm);
}

// ── Consensus Activity ─────────────────────────────────────────────────────

/**
 * Consensus aggregation activity — reconciles the three review branches.
 * Uses the `frontier` LLM tier.
 *
 * @param input - The three sets of review findings to reconcile.
 * @returns A {@link ConsensusResult} with aggregated findings and counts.
 */
export async function aggregateConsensusActivity(
  input: { logic: ReviewFinding[]; risk: ReviewFinding[]; consistency: ReviewFinding[] },
): Promise<ConsensusResult> {
  const { llm } = await createFreshLLM();
  const { aggregateConsensus } = await import('./consensus/aggregator.js');
  return aggregateConsensus(input, llm);
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
 * @param context  - The assembled pipeline context.
 * @returns A Record mapping finding issue text to its {@link CoVeVerdict}.
 */
export async function runCoVeActivity(
  findings: ConsensusFinding[],
  context: PipelineContext,
): Promise<Record<string, CoVeVerdict>> {
  const { llm, budget } = await createFreshLLM();
  const { runCoVe } = await import('./cove/workflow.js');
  return runCoVe(findings, context, llm, budget);
}

// ── Report Activity ────────────────────────────────────────────────────────

/**
 * Report formatting activity — transforms verified findings into the final review output.
 * Uses the `base` LLM tier.
 *
 * @param verifiedFindings - Consensus findings after CoVe verification.
 * @param coveResults      - CoVe verdicts keyed by finding issue text.
 * @param landscape        - The repository landscape artifact for context.
 * @returns The final {@link ReviewOutput} with inline comments and summary.
 */
export async function formatReportActivity(
  verifiedFindings: ConsensusFinding[],
  coveResults: Record<string, CoVeVerdict>,
  landscape: LandscapeArtifact,
): Promise<ReviewOutput> {
  const { llm } = await createFreshLLM();
  const { formatReport } = await import('./report/formatter.js');
  return formatReport(verifiedFindings, coveResults, landscape, llm);
}
