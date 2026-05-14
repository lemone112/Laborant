/**
 * @module pipeline/langgraph/review-graph
 * @description LangGraph state graph for the review pipeline.
 *
 * Implements the full pipeline as a LangGraph state machine:
 *
 *   START → context_assembly → triple_review → consensus → [cove?] → report → END
 *
 * The triple_review node runs all three reviewers in parallel within a single node
 * via `Promise.all`. For true graph-level parallelism (fan-out/fan-in), use
 * LangGraph's `send()` API with separate nodes per reviewer.
 *
 * Each reviewer's result is stored in the shared state.
 *
 * Conditional edges:
 * - If consensus has escalated findings → run CoVe
 * - Otherwise → skip directly to report
 *
 * Benefits of LangGraph over plain async functions:
 * - State checkpointing between nodes
 * - Conditional branching based on intermediate results
 * - Built-in retry and error handling per node
 * - Human-in-the-loop via interrupt() for disputed findings
 * - Observability via LangSmith integration
 */

import { StateGraph, END, START, MemorySaver } from '@langchain/langgraph';
import { Annotation } from '@langchain/langgraph';
import type {
  ReviewFinding,
  CoVeVerdict,
  LandscapeArtifact,
  RiskMapEntry,
  ReviewOutput,
} from '../../config/defaults.js';
import type { PipelineContext } from '../context-assembly/builder.js';
import type { ConsensusResult } from '../consensus/aggregator.js';
import type { LLMClient } from '../../llm/client.js';
import type { BudgetTracker } from '../../llm/budget.js';

// ── State Annotation ───────────────────────────────────────────────────────

/**
 * Shared state for the review pipeline graph.
 * Each node reads from and writes to this state.
 *
 * Reducers use the "last write wins" pattern (`(_, b) => b`) for fields
 * that are set once by a single node, and default factories for fields
 * that start empty.
 *
 * **Note on non-serialisable fields:** `_llm` and `_budget` hold the LLM
 * client and budget tracker instances. These are NOT serialisable and will
 * be stripped by LangGraph's checkpointer. They are threaded through state
 * for developer convenience within a single process invocation. For
 * distributed execution, inject these via a closure or context object
 * instead of the state graph.
 */
const ReviewState = Annotation.Root({
  // Input
  diff: Annotation<string>({ reducer: (_, b) => b }),
  changedFiles: Annotation<string[]>({ reducer: (_, b) => b }),

  // Context Assembly outputs
  landscape: Annotation<LandscapeArtifact>({ reducer: (_, b) => b, default: () => ({ architecture: 'unknown', patterns: [], conventions: [], intentional: [] }) }),
  riskMap: Annotation<RiskMapEntry[]>({ reducer: (_, b) => b, default: () => [] }),

  // Triple Review outputs
  logicFindings: Annotation<ReviewFinding[]>({ reducer: (_, b) => b, default: () => [] }),
  riskFindings: Annotation<ReviewFinding[]>({ reducer: (_, b) => b, default: () => [] }),
  consistencyFindings: Annotation<ReviewFinding[]>({ reducer: (_, b) => b, default: () => [] }),

  // Consensus output
  consensusResult: Annotation<ConsensusResult | null>({ reducer: (_, b) => b, default: () => null }),

  // CoVe output (stored as Record for serialisability)
  coveResults: Annotation<Record<string, CoVeVerdict>>({ reducer: (_, b) => b, default: () => ({}) }),

  // Final output
  output: Annotation<ReviewOutput | null>({ reducer: (_, b) => b, default: () => null }),
  error: Annotation<string | null>({ reducer: (_, b) => b, default: () => null }),

  // Internal: LLM client (not serialisable — for single-process use only)
  _llm: Annotation<LLMClient>({ reducer: (_, b) => b }),
  // Internal: Budget tracker (not serialisable — for single-process use only)
  _budget: Annotation<BudgetTracker>({ reducer: (_, b) => b }),
});

type ReviewStateType = typeof ReviewState.State;

// ── Node implementations ───────────────────────────────────────────────────

/**
 * Context Assembly node — builds landscape, risk map, and similar-pattern context.
 */
async function contextAssemblyNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  try {
    const { buildContext } = await import('../context-assembly/builder.js');
    const context = await buildContext(
      {
        diff: state.diff,
        changedFiles: state.changedFiles,
        repoPath: process.cwd(),
      },
      state._llm,
      state._budget,
    );

    return {
      landscape: context.landscape,
      riskMap: context.riskMap,
    };
  } catch (err) {
    return { error: `Context assembly failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Triple Review node — runs all three reviewers in parallel.
 *
 * Although this is a single LangGraph node, the three review branches
 * (Logic, Risk, Consistency) are executed concurrently via `Promise.all`.
 * For true graph-level parallelism, use LangGraph's `send()` API with
 * separate nodes per reviewer.
 */
async function tripleReviewNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  const llm = state._llm;
  const context: PipelineContext = {
    diff: state.diff,
    changedFiles: state.changedFiles,
    landscape: state.landscape,
    riskMap: state.riskMap,
    similarPatterns: [],
    budgetUsed: 0,
  };

  try {
    // Run all three reviewers in parallel
    const [logicFindings, riskFindings, consistencyFindings] = await Promise.all([
      import('../triple-review/logic.js').then(m => m.reviewLogic(context, llm)),
      import('../triple-review/risk.js').then(m => m.reviewRisk(context, llm)),
      import('../triple-review/consistency.js').then(m => m.reviewConsistency(context, llm)),
    ]);

    return { logicFindings, riskFindings, consistencyFindings };
  } catch (err) {
    return { error: `Triple review failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * Consensus node — aggregates the three review branches into a single set of findings.
 */
async function consensusNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  if (state.error) return {};

  try {
    const llm = state._llm;
    const { aggregateConsensus } = await import('../consensus/aggregator.js');
    const result = await aggregateConsensus(
      {
        logic: state.logicFindings,
        risk: state.riskFindings,
        consistency: state.consistencyFindings,
      },
      llm,
    );

    return { consensusResult: result };
  } catch (err) {
    return { error: `Consensus failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

/**
 * CoVe (Chain-of-Verification) node — verifies escalated findings.
 *
 * Only runs when the consensus step produces escalated findings.
 * CoVe failure is non-fatal — the pipeline proceeds with unverified findings.
 */
async function coveNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  if (state.error) return {};
  if (!state.consensusResult) return {};

  try {
    const context: PipelineContext = {
      diff: state.diff,
      changedFiles: state.changedFiles,
      landscape: state.landscape,
      riskMap: state.riskMap,
      similarPatterns: [],
      budgetUsed: 0,
    };

    const { runCoVe } = await import('../cove/workflow.js');
    const coveResults = await runCoVe(
      state.consensusResult.findings,
      context,
      state._llm,
      state._budget,
    );

    // runCoVe already returns Record<string, CoVeVerdict>
    return { coveResults };
  } catch (err) {
    // CoVe failure is non-fatal — proceed with unverified findings
    console.warn(`[langgraph] CoVe failed (non-fatal): ${err instanceof Error ? err.message : String(err)}`);
    return { coveResults: {} };
  }
}

/**
 * Report node — formats verified findings into the final review output.
 */
async function reportNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
  try {
    const { formatReport } = await import('../report/formatter.js');

    const output = await formatReport(
      state.consensusResult?.findings ?? [],
      state.coveResults,
      state.landscape,
      state._llm,
    );
    return { output };
  } catch (err) {
    return { error: `Report generation failed: ${err instanceof Error ? err.message : String(err)}` };
  }
}

// ── Conditional edges ──────────────────────────────────────────────────────

/**
 * Decide whether to run CoVe after consensus.
 *
 * - Skip CoVe if there was an upstream error
 * - Skip CoVe if consensus produced no escalated findings
 * - Skip CoVe if no consensus result exists
 * - Run CoVe if there are escalated findings
 */
function shouldRunCoVe(state: ReviewStateType): string {
  if (state.error) return 'report';
  if (!state.consensusResult) return 'report';
  if (state.consensusResult.escalateCount === 0) return 'report';
  return 'cove';
}

// ── Graph builder ──────────────────────────────────────────────────────────

/**
 * Build and compile the LangGraph review pipeline.
 *
 * The compiled graph is a LangGraph `Runnable` that can be invoked with
 * an initial state object. Nodes execute sequentially (with the triple
 * review step running its three branches internally via `Promise.all`),
 * and conditional edges determine whether CoVe runs.
 *
 * A `MemorySaver` checkpointer is attached so that state is preserved
 * between node executions — useful for debugging and human-in-the-loop
 * scenarios where the graph may be paused and resumed.
 *
 * @returns A compiled LangGraph runnable.
 *
 * @example
 * ```ts
 * const graph = buildReviewGraph();
 * const result = await graph.invoke({
 *   diff: mrDiff,
 *   changedFiles: ['src/auth.ts'],
 *   _llm: llmClient,
 *   _budget: budgetTracker,
 * });
 * console.log(result.output);
 * ```
 */
export function buildReviewGraph() {
  const checkpointer = new MemorySaver();

  const graph = new StateGraph(ReviewState)
    .addNode('context_assembly', contextAssemblyNode)
    .addNode('triple_review', tripleReviewNode)
    .addNode('consensus', consensusNode)
    .addNode('cove', coveNode)
    .addNode('report', reportNode)

    // Linear flow with conditional CoVe
    .addEdge(START, 'context_assembly')
    .addEdge('context_assembly', 'triple_review')
    .addEdge('triple_review', 'consensus')
    .addConditionalEdges('consensus', shouldRunCoVe, {
      cove: 'cove',
      report: 'report',
    })
    .addEdge('cove', 'report')
    .addEdge('report', END);

  return graph.compile({ checkpointer });
}

/**
 * Run the full review pipeline via LangGraph.
 * This is the primary entry point for the review pipeline when using LangGraph.
 *
 * @param input  - The review input (diff, changed files).
 * @param llm    - The LLM client instance to use for LLM calls.
 * @param budget - The budget tracker to record usage.
 * @returns The final review output, or `null` if the pipeline failed.
 *
 * @example
 * ```ts
 * const output = await runReviewViaLangGraph(
 *   { diff: mrDiff, changedFiles: ['src/auth.ts'] },
 *   llmClient,
 *   budgetTracker,
 * );
 * if (output) {
 *   console.log(output.summary);
 *   for (const comment of output.inline) {
 *     console.log(`${comment.file}:${comment.line} [${comment.severity}] ${comment.body}`);
 *   }
 * }
 * ```
 */
export async function runReviewViaLangGraph(
  input: { diff: string; changedFiles: string[] },
  llm: LLMClient,
  budget: BudgetTracker,
): Promise<ReviewOutput | null> {
  const graph = buildReviewGraph();

  const result = await graph.invoke({
    diff: input.diff,
    changedFiles: input.changedFiles,
    _llm: llm,
    _budget: budget,
  });

  return result.output;
}
