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
 * ### Architecture: Closure-based Dependency Injection
 *
 * The LLM client and budget tracker are NOT stored in the graph state (they are
 * non-serialisable). Instead, they are injected via a closure when building the
 * graph. This ensures:
 * 1. The state is fully serialisable for LangGraph's checkpointer
 * 2. Checkpoint/resume works correctly (no missing references)
 * 3. The graph can be safely serialised and transported
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
 * IMPORTANT: All state fields MUST be fully serialisable (JSON-compatible).
 * Non-serialisable objects (LLMClient, BudgetTracker) are injected via
 * closures in `buildReviewGraph()`, not stored in state.
 */
const ReviewState = Annotation.Root({
  // Input
  diff: Annotation<string>({ reducer: (_, b) => b }),
  changedFiles: Annotation<string[]>({ reducer: (_, b) => b }),
  repoPath: Annotation<string>({ reducer: (_, b) => b, default: () => process.cwd() }),

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
});

type ReviewStateType = typeof ReviewState.State;

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
 * ### Dependency Injection via Closures
 *
 * The `llm` and `budget` parameters are captured in the closures of each
 * node function. This means they are NOT part of the serialisable state
 * and will NOT be lost during checkpoint/resume cycles. Each node function
 * has direct access to these dependencies through lexical scope.
 *
 * @param llm    - The LLM client instance to use for LLM calls.
 * @param budget - The budget tracker to record usage.
 * @returns A compiled LangGraph runnable.
 *
 * @example
 * ```ts
 * const graph = buildReviewGraph(llmClient, budgetTracker);
 * const result = await graph.invoke({
 *   diff: mrDiff,
 *   changedFiles: ['src/auth.ts'],
 *   repoPath: '/home/user/project',
 * });
 * console.log(result.output);
 * ```
 */
export function buildReviewGraph(llm: LLMClient, budget: BudgetTracker) {
  // ── Node implementations (with closure access to llm and budget) ──

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
          repoPath: state.repoPath,
        },
        llm,
        budget,
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
   */
  async function tripleReviewNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
    const context: PipelineContext = {
      diff: state.diff,
      changedFiles: state.changedFiles,
      landscape: state.landscape,
      riskMap: state.riskMap,
      similarPatterns: [],
      budgetUsed: 0,
    };

    try {
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
   * Consensus node — aggregates the three review branches.
   */
  async function consensusNode(state: ReviewStateType): Promise<Partial<ReviewStateType>> {
    if (state.error) return {};

    try {
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
   * CoVe node — verifies escalated findings. Non-fatal on failure.
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
        llm,
        budget,
      );

      return { coveResults };
    } catch (err) {
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
        llm,
      );
      return { output };
    } catch (err) {
      return { error: `Report generation failed: ${err instanceof Error ? err.message : String(err)}` };
    }
  }

  // ── Conditional edges ──────────────────────────────────────────────────

  function shouldRunCoVe(state: ReviewStateType): string {
    if (state.error) return 'report';
    if (!state.consensusResult) return 'report';
    if (state.consensusResult.escalateCount === 0) return 'report';
    return 'cove';
  }

  // ── Build and compile graph ──────────────────────────────────────────────

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
 *
 * This is the primary entry point for the review pipeline when using LangGraph.
 * Dependencies (LLMClient, BudgetTracker) are injected into the graph via
 * closures, keeping the state fully serialisable.
 *
 * @param input  - The review input (diff, changed files, repo path).
 * @param llm    - The LLM client instance to use for LLM calls.
 * @param budget - The budget tracker to record usage.
 * @returns The final review output, or `null` if the pipeline failed.
 *
 * @example
 * ```ts
 * const output = await runReviewViaLangGraph(
 *   { diff: mrDiff, changedFiles: ['src/auth.ts'], repoPath: '/home/user/project' },
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
  input: { diff: string; changedFiles: string[]; repoPath?: string },
  llm: LLMClient,
  budget: BudgetTracker,
): Promise<ReviewOutput | null> {
  const graph = buildReviewGraph(llm, budget);

  const result = await graph.invoke({
    diff: input.diff,
    changedFiles: input.changedFiles,
    repoPath: input.repoPath ?? process.cwd(),
  });

  return result.output;
}
