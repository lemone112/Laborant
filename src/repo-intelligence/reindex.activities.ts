/**
 * @module repo-intelligence/reindex.activities
 * @description Temporal activity implementations for the reindex pipeline.
 *
 * These activities implement the four steps of the reindex workflow:
 * 1. Clone or update the repository
 * 2. Run the AST indexer
 * 3. Sync symbols to Neo4j
 * 4. Sync symbol embeddings to Qdrant
 *
 * Each activity is self-contained and creates its own client instances.
 */

import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import type { SymbolInfo } from './ast-indexer.js';
import { indexRepository } from './ast-indexer.js';
import { createGraphClient } from './graph-sync.js';
import { createEmbeddingClient } from './embedding-sync.js';
import { createLLMClient } from '../llm/client.js';
import { createBudgetTracker } from '../llm/budget.js';
import { env } from '../config/env.js';

const execFileAsync = promisify(execFile);

/**
 * Activity: Clones the repository if it does not exist locally, or pulls the
 * latest changes on the specified branch.
 *
 * @param repoPath - Absolute local path for the repository clone.
 * @param repoUrl  - Remote Git repository URL.
 * @param branch   - Branch name to checkout and pull.
 * @throws {Error} If the clone or pull operation fails.
 */
export async function cloneOrUpdateRepo(
  repoPath: string,
  repoUrl: string,
  branch: string,
): Promise<void> {
  try {
    // Check if the repo already exists
    await execFileAsync('git', ['rev-parse', '--is-inside-work-tree'], {
      cwd: repoPath,
    });
    // Repo exists — pull latest changes
    await execFileAsync('git', ['fetch', 'origin', branch], { cwd: repoPath });
    await execFileAsync('git', ['checkout', branch], { cwd: repoPath });
    await execFileAsync('git', ['reset', '--hard', `origin/${branch}`], { cwd: repoPath });
    console.log(`[reindex] Pulled latest changes for branch "${branch}"`);
  } catch {
    // Repo doesn't exist — clone it
    await execFileAsync('git', ['clone', '--branch', branch, '--depth', '1', repoUrl, repoPath]);
    console.log(`[reindex] Cloned repository to ${repoPath}`);
  }
}

/**
 * Activity: Runs the AST indexer on the given repository path.
 *
 * @param repoPath - Absolute path to the local repository.
 * @returns An array of extracted symbol information.
 */
export async function runAstIndexer(repoPath: string): Promise<SymbolInfo[]> {
  console.log(`[reindex] Running AST indexer on ${repoPath}`);
  const symbols = await indexRepository(repoPath);
  console.log(`[reindex] Indexed ${symbols.length} symbols`);
  return symbols;
}

/**
 * Activity: Syncs extracted symbols to Neo4j.
 *
 * Creates a graph client, syncs the symbols, and closes the connection.
 *
 * @param symbols - The symbols to persist in Neo4j.
 */
export async function syncToNeo4j(symbols: SymbolInfo[]): Promise<void> {
  console.log(`[reindex] Syncing ${symbols.length} symbols to Neo4j`);
  const client = createGraphClient();
  try {
    await client.syncSymbols(symbols);
    console.log(`[reindex] Neo4j sync complete`);
  } finally {
    await client.close();
  }
}

/**
 * Activity: Embeds symbols and syncs them to Qdrant.
 *
 * Uses the configured LLM embedding model for vector generation.
 *
 * @param symbols - The symbols to embed and upsert.
 */
export async function syncToQdrant(symbols: SymbolInfo[]): Promise<void> {
  console.log(`[reindex] Syncing ${symbols.length} symbol embeddings to Qdrant`);
  const budget = createBudgetTracker();
  const llm = createLLMClient(budget);
  const embClient = createEmbeddingClient();

  const embedFn = async (texts: string[]): Promise<number[][]> => {
    const result = await llm.embed(texts);
    return result.embeddings;
  };

  await embClient.ensureCollection('code_symbols', env.LLM_EMBEDDING_DIM);
  await embClient.syncEmbeddings(symbols, embedFn);
  console.log(`[reindex] Qdrant sync complete`);
}
