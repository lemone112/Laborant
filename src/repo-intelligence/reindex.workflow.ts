/**
 * @module repo-intelligence/reindex.workflow
 * @description Temporal workflow that orchestrates the full re-indexing pipeline
 * for a repository. The workflow coordinates four main activities:
 *
 * 1. **Clone / Update** — ensures the local copy of the repository is up to date.
 * 2. **AST Index** — parses source files and extracts symbol information.
 * 3. **Neo4j Sync** — persists symbols and their dependency relationships.
 * 4. **Qdrant Sync** — embeds symbols and upserts them for semantic search.
 *
 * The workflow is designed to handle partial failures gracefully: if the Neo4j
 * sync step fails, the Qdrant sync step is still attempted (and vice versa).
 * This ensures that a transient database outage does not block the entire
 * indexing pipeline.
 *
 * ## Usage
 *
 * ```ts
 * import { WorkflowClient } from '@temporalio/client';
 * import { reindexWorkflow } from './reindex.workflow.js';
 *
 * const client = new WorkflowClient();
 * const handle = await client.start(reindexWorkflow, {
 *   args: [{ repoPath: '/repos/my-project', repoUrl: 'https://github.com/org/repo', branch: 'main' }],
 *   taskQueue: 'reindex',
 *   workflowId: `reindex-my-project-${Date.now()}`,
 * });
 * ```
 */

import { proxyActivities, log } from '@temporalio/workflow';
import type { SymbolInfo } from './ast-indexer.js';

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Input parameters for the reindex workflow.
 */
export interface ReindexWorkflowInput {
  /** Absolute local path where the repository is (or will be) cloned. */
  repoPath: string;
  /** Remote URL of the Git repository (used for cloning if needed). */
  repoUrl: string;
  /** The branch to checkout and index (default: `'main'`). */
  branch: string;
}

/**
 * Result of the reindex workflow, summarising the outcome of each step.
 */
export interface ReindexWorkflowResult {
  /** Whether the clone/update step succeeded. */
  cloneSuccess: boolean;
  /** Number of symbols extracted by the AST indexer. */
  symbolCount: number;
  /** Whether the Neo4j sync step succeeded. */
  neo4jSyncSuccess: boolean;
  /** Whether the Qdrant sync step succeeded. */
  qdrantSyncSuccess: boolean;
  /** Error messages from any failed steps. */
  errors: string[];
}

/**
 * Interface describing the activities that the workflow proxies to.
 * Each activity is a standalone function that executes in the activity worker
 * context (outside the workflow sandbox).
 */
export interface ReindexActivities {
  /**
   * Clones the repository if it does not exist locally, or pulls the latest
   * changes on the specified branch.
   *
   * @param repoPath - Local path for the repository.
   * @param repoUrl  - Remote Git URL.
   * @param branch   - Branch to checkout / pull.
   */
  cloneOrUpdateRepo(repoPath: string, repoUrl: string, branch: string): Promise<void>;

  /**
   * Runs the AST indexer on the repository and returns the extracted symbols.
   *
   * @param repoPath - Absolute path to the local repository.
   * @returns An array of extracted symbol information.
   */
  runAstIndexer(repoPath: string): Promise<SymbolInfo[]>;

  /**
   * Syncs the extracted symbols into Neo4j, creating nodes and relationships.
   *
   * @param symbols - The symbols to persist.
   */
  syncToNeo4j(symbols: SymbolInfo[]): Promise<void>;

  /**
   * Embeds the symbols and upserts them into Qdrant for semantic search.
   *
   * @param symbols - The symbols to embed and upsert.
   */
  syncToQdrant(symbols: SymbolInfo[]): Promise<void>;
}

// ────────────────────────────────────────────────────────────────────────────────
// Activity proxy
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Proxied activity interface configured with sensible defaults for the
 * reindex pipeline. Activities are retried automatically by Temporal based
 * on the retry policy.
 */
const {
  cloneOrUpdateRepo,
  runAstIndexer,
  syncToNeo4j,
  syncToQdrant,
} = proxyActivities<ReindexActivities>({
  startToCloseTimeout: '10 minutes',
  retry: {
    maximumAttempts: 3,
    initialInterval: '5 seconds',
    backoffCoefficient: 2,
    nonRetryableErrorTypes: [
      'ApplicationError',
      'SyntaxError',
    ],
  },
});

// ────────────────────────────────────────────────────────────────────────────────
// Workflow
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Main Temporal workflow for re-indexing a repository.
 *
 * The workflow executes four activities in sequence, with partial-failure
 * tolerance: if the Neo4j sync fails, the Qdrant sync is still attempted.
 * All step outcomes are collected into the {@link ReindexWorkflowResult}.
 *
 * ### Execution Flow
 *
 * ```
 * ┌──────────────┐     ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
 * │ Clone/Update │────▶│  AST Index   │────▶│  Neo4j Sync  │────▶│ Qdrant Sync  │
 * └──────────────┘     └──────────────┘     └──────────────┘     └──────────────┘
 *                                                  │                     │
 *                                                  ▼                     ▼
 *                                            (on failure,           (on failure,
 *                                             still continue)        record error)
 * ```
 *
 * @param input - The workflow input parameters.
 * @returns A summary of what succeeded and what failed.
 *
 * @example
 * ```ts
 * const result = await reindexWorkflow({
 *   repoPath: '/repos/my-project',
 *   repoUrl: 'https://gitlab.company.com/team/repo.git',
 *   branch: 'main',
 * });
 * console.log(`Indexed ${result.symbolCount} symbols`);
 * if (result.errors.length > 0) {
 *   console.warn('Partial failures:', result.errors);
 * }
 * ```
 */
export async function reindexWorkflow(
  input: ReindexWorkflowInput,
): Promise<ReindexWorkflowResult> {
  const result: ReindexWorkflowResult = {
    cloneSuccess: false,
    symbolCount: 0,
    neo4jSyncSuccess: false,
    qdrantSyncSuccess: false,
    errors: [],
  };

  log.info('[reindex] Starting reindex workflow', { input });

  // ── Step 1: Clone or update the repository ────────────────────────────────
  try {
    log.info('[reindex] Step 1: Cloning/updating repository', {
      repoPath: input.repoPath,
      branch: input.branch,
    });
    await cloneOrUpdateRepo(input.repoPath, input.repoUrl, input.branch);
    result.cloneSuccess = true;
    log.info('[reindex] Step 1 complete: repository ready');
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`Clone/update failed: ${message}`);
    log.error('[reindex] Step 1 failed: clone/update error', { error: message });
    // Cannot proceed without the repository — return early.
    return result;
  }

  // ── Step 2: Run the AST indexer ──────────────────────────────────────────
  let symbols: SymbolInfo[];
  try {
    log.info('[reindex] Step 2: Running AST indexer', {
      repoPath: input.repoPath,
    });
    symbols = await runAstIndexer(input.repoPath);
    result.symbolCount = symbols.length;
    log.info('[reindex] Step 2 complete: extracted symbols', {
      count: symbols.length,
    });
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    result.errors.push(`AST indexing failed: ${message}`);
    log.error('[reindex] Step 2 failed: AST indexer error', { error: message });
    // Cannot proceed without symbols — return early.
    return result;
  }

  // ── Steps 3 & 4: Sync to Neo4j and Qdrant (partial-failure tolerant) ────
  // We attempt both sync steps even if one fails. This ensures that a
  // transient Neo4j outage does not prevent Qdrant from being updated
  // (and vice versa).

  const neo4jPromise = syncToNeo4j(symbols)
    .then(() => {
      result.neo4jSyncSuccess = true;
      log.info('[reindex] Step 3 complete: Neo4j sync successful');
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Neo4j sync failed: ${message}`);
      log.error('[reindex] Step 3 failed: Neo4j sync error', { error: message });
    });

  const qdrantPromise = syncToQdrant(symbols)
    .then(() => {
      result.qdrantSyncSuccess = true;
      log.info('[reindex] Step 4 complete: Qdrant sync successful');
    })
    .catch((err: unknown) => {
      const message = err instanceof Error ? err.message : String(err);
      result.errors.push(`Qdrant sync failed: ${message}`);
      log.error('[reindex] Step 4 failed: Qdrant sync error', { error: message });
    });

  // Wait for both sync operations to settle (success or failure).
  // Note: Temporal workflows must be deterministic. Using Promise.all
  // here is safe because both activities were already scheduled by the
  // proxy — we are only awaiting their completion.
  await Promise.all([neo4jPromise, qdrantPromise]);

  // ── Summary ──────────────────────────────────────────────────────────────
  const overallSuccess =
    result.cloneSuccess &&
    result.symbolCount > 0 &&
    result.neo4jSyncSuccess &&
    result.qdrantSyncSuccess;

  if (overallSuccess) {
    log.info('[reindex] Workflow completed successfully', {
      symbolCount: result.symbolCount,
    });
  } else {
    log.warn('[reindex] Workflow completed with partial failures', {
      symbolCount: result.symbolCount,
      neo4jSyncSuccess: result.neo4jSyncSuccess,
      qdrantSyncSuccess: result.qdrantSyncSuccess,
      errors: result.errors,
    });
  }

  return result;
}

// ────────────────────────────────────────────────────────────────────────────────
// Activity Implementations (Stubs)
// ────────────────────────────────────────────────────────────────────────────────
// These are placeholder implementations that would typically live in a separate
// activity module. They are provided here for reference and must be registered
// with the Temporal worker via `worker.registerActivities()`.
//
// IMPORTANT: Activity implementations must NOT be imported inside a workflow
// file that runs in the Temporal workflow sandbox. Instead, they should be
// registered with the worker independently. The stubs below are for
// documentation purposes only.

/**
 * Activity: Clones the repository if it does not exist, or pulls the latest
 * changes on the specified branch.
 *
 * @param repoPath - Absolute local path for the repository clone.
 * @param repoUrl  - Remote Git repository URL.
 * @param branch   - Branch name to checkout and pull.
 * @throws {Error} If the clone or pull operation fails.
 *
 * @example
 * ```ts
 * // Worker registration:
 * worker.registerActivities({
 *   cloneOrUpdateRepo: async (repoPath, repoUrl, branch) => {
 *     const { execFile } = require('child_process/promises');
 *     try {
 *       await execFile('git', ['rev-parse', '--is-inside-work-tree'], { cwd: repoPath });
 *       await execFile('git', ['pull', '--ff-only', 'origin', branch], { cwd: repoPath });
 *     } catch {
 *       await execFile('git', ['clone', '--branch', branch, repoUrl, repoPath]);
 *     }
 *   },
 * });
 * ```
 */
export async function cloneOrUpdateRepoActivity(
  _repoPath: string,
  _repoUrl: string,
  _branch: string,
): Promise<void> {
  // Stub — must be implemented in the activity worker and registered
  // with the Temporal worker. See example in JSDoc above.
  throw new Error('cloneOrUpdateRepo activity not implemented');
}

/**
 * Activity: Runs the AST indexer on the given repository path.
 *
 * Delegates to {@link indexRepository} from `./ast-indexer.js`.
 *
 * @param repoPath - Absolute path to the local repository.
 * @returns An array of extracted symbol information.
 *
 * @example
 * ```ts
 * // Worker registration:
 * import { indexRepository } from './ast-indexer.js';
 * worker.registerActivities({
 *   runAstIndexer: async (repoPath) => {
 *     return indexRepository(repoPath);
 *   },
 * });
 * ```
 */
export async function runAstIndexerActivity(
  _repoPath: string,
): Promise<SymbolInfo[]> {
  // Stub — must be implemented in the activity worker and registered
  // with the Temporal worker. See example in JSDoc above.
  throw new Error('runAstIndexer activity not implemented');
}

/**
 * Activity: Syncs extracted symbols to Neo4j.
 *
 * Delegates to {@link createGraphClient} and its `syncSymbols` method
 * from `./graph-sync.js`.
 *
 * @param symbols - The symbols to persist in Neo4j.
 *
 * @example
 * ```ts
 * // Worker registration:
 * import { createGraphClient } from './graph-sync.js';
 * worker.registerActivities({
 *   syncToNeo4j: async (symbols) => {
 *     const client = createGraphClient();
 *     try {
 *       await client.syncSymbols(symbols);
 *     } finally {
 *       await client.close();
 *     }
 *   },
 * });
 * ```
 */
export async function syncToNeo4jActivity(
  _symbols: SymbolInfo[],
): Promise<void> {
  // Stub — must be implemented in the activity worker and registered
  // with the Temporal worker. See example in JSDoc above.
  throw new Error('syncToNeo4j activity not implemented');
}

/**
 * Activity: Embeds symbols and syncs them to Qdrant.
 *
 * Delegates to {@link createEmbeddingClient} from `./embedding-sync.js`
 * and uses the configured embedding model for vector generation.
 *
 * @param symbols - The symbols to embed and upsert.
 *
 * @example
 * ```ts
 * // Worker registration:
 * import { createEmbeddingClient } from './embedding-sync.js';
 * import { env } from '../config/env.js';
 * import OpenAI from 'openai';
 * worker.registerActivities({
 *   syncToQdrant: async (symbols) => {
 *     const client = createEmbeddingClient();
 *     const openai = new OpenAI({ baseURL: env.llmBaseUrl, apiKey: env.llmApiKey });
 *     const embedFn = async (texts: string[]) => {
 *       const resp = await openai.embeddings.create({
 *         model: env.llmEmbeddingModel,
 *         input: texts,
 *       });
 *       return resp.data.map((d) => d.embedding);
 *     };
 *     await client.ensureCollection('code_symbols', env.llmEmbeddingDim);
 *     await client.syncEmbeddings(symbols, embedFn);
 *   },
 * });
 * ```
 */
export async function syncToQdrantActivity(
  _symbols: SymbolInfo[],
): Promise<void> {
  // Stub — must be implemented in the activity worker and registered
  // with the Temporal worker. See example in JSDoc above.
  throw new Error('syncToQdrant activity not implemented');
}
