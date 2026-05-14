/**
 * @module pipeline/context-assembly/builder
 * @description Context Assembly — the first stage of the AI Code Review pipeline.
 *
 * Combines the repository landscape, dependency risk map, diff content, and
 * similar-code patterns into a single {@link PipelineContext} object that
 * downstream review stages consume.
 *
 * ### Assembly order
 * 1. **Landscape scan** — LLM reads the file tree and produces architectural
 *    context (architecture, patterns, conventions, intentional decisions).
 * 2. **Risk map** — queries Neo4j for transitive dependents of changed files.
 *    Falls back to LLM-based risk mapping when Neo4j is unavailable.
 * 3. **Similar patterns** — embeds the diff via the LLM embedding model and
 *    searches Qdrant for semantically similar code symbols.
 * 4. **Budget tracking** — records total budget consumed during assembly.
 *
 * All LLM calls are routed through the tier system — no hardcoded model names.
 */

import { env } from '../../config/env.js';
import {
  PIPELINE_MODEL_MAP,
  type LandscapeArtifact,
  type RiskMapEntry,
} from '../../config/defaults.js';
import type { LLMClient } from '../../llm/client.js';
import type { BudgetTracker } from '../../llm/budget.js';
import { createGraphClient, type DependentSymbol } from '../../repo-intelligence/graph-sync.js';
import {
  createEmbeddingClient,
  type SearchResult,
} from '../../repo-intelligence/embedding-sync.js';
import { chunkDiff, type DiffChunk } from '../../util/diff-chunker.js';
import { loadPrompt } from '../../util/prompts.js';

// ────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────

/**
 * The fully assembled context object consumed by every downstream pipeline
 * stage (triple review, consensus, CoVe, report).
 *
 * Each field is populated by a distinct sub-step of the assembly process and
 * is guaranteed to be present (though possibly empty) after `buildContext`
 * resolves.
 */
export interface PipelineContext {
  /** Architectural landscape produced by the LLM landscape scan. */
  landscape: LandscapeArtifact;

  /** Risk map entries — one per changed entity with blast-radius info. */
  riskMap: RiskMapEntry[];

  /** The raw unified diff of the merge request. */
  diff: string;

  /** List of file paths changed in the merge request. */
  changedFiles: string[];

  /** Semantically similar code symbols found via Qdrant vector search. */
  similarPatterns: SearchResult[];

  /** Cumulative budget consumed (in USD) during the assembly step. */
  budgetUsed: number;
}

/**
 * Input parameters for the {@link buildContext} function.
 * Mirrors the data available from a GitLab merge request webhook.
 */
export interface BuildContextInput {
  /** The raw unified diff of the merge request. */
  diff: string;

  /** Relative paths of files changed in the merge request. */
  changedFiles: string[];

  /** Absolute path to the repository root on disk. */
  repoPath: string;
}

// ────────────────────────────────────────────────────────────────────────────
// Landscape scan
// ────────────────────────────────────────────────────────────────────────────

/**
 * Runs the landscape scan step — asks the LLM to analyse the repository file
 * tree and extract architectural context.
 *
 * Uses the `cheap` tier (as declared in {@link PIPELINE_MODEL_MAP.landscapeScan})
 * because the landscape scan is a broad, shallow classification task.
 *
 * @param llm        - The LLM client instance to use.
 * @param repoPath   - Absolute path to the repository root.
 * @param diff       - The raw diff (provides change context to the LLM).
 * @returns A {@link LandscapeArtifact} with architecture, patterns, conventions,
 *   and intentional decisions.
 */
async function scanLandscape(
  llm: LLMClient,
  repoPath: string,
  diff: string,
): Promise<LandscapeArtifact> {
  const tier = PIPELINE_MODEL_MAP.landscapeScan;
  const prompt = await loadPrompt('landscape');

  // Build a compact file-tree representation for the LLM
  const fileTree = diff
    .split('\n')
    .filter((line) => line.startsWith('+++ ') || line.startsWith('--- '))
    .map((line) => line.replace(/^[+-]{3}\s*/, ''))
    .join('\n');

  // Chunk the diff if it's too large for a single LLM call
  const chunks = chunkDiff(diff, { maxTokensPerChunk: 6000 });
  const diffForLLM = chunks.length === 1
    ? chunks[0]?.content ?? diff
    : chunks.map((c: DiffChunk, i: number) => `--- Chunk ${i + 1}/${chunks.length} (${c.files.join(', ')}) ---\n${c.content}`).join('\n\n');

  const userContent = [
    `Repository path: ${repoPath}`,
    `Changed files tree:`,
    fileTree || '(no file markers in diff)',
    '',
    'Diff for context:',
    diffForLLM.slice(0, 8000), // Truncate to avoid token overflow
  ].join('\n');

  const result = await llm.complete(tier, prompt, userContent, {
    jsonMode: true,
  });

  // Parse the structured landscape from the LLM response
  const parsed = result.parsed ?? {};
  return {
    architecture: String(parsed['architecture'] ?? parsed['ARCHITECTURE'] ?? 'unknown'),
    patterns: toArray(parsed['patterns'] ?? parsed['PATTERNS'] ?? []),
    conventions: toArray(parsed['conventions'] ?? parsed['CONVENTIONS'] ?? []),
    intentional: toArray(parsed['intentional'] ?? parsed['INTENTIONAL'] ?? []),
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Risk map
// ────────────────────────────────────────────────────────────────────────────

/**
 * Builds the risk map by querying Neo4j for transitive dependents of each
 * changed file.
 *
 * Each file's dependents are classified as `direct` (1 hop) or `indirect`
 * (2+ hops), and a composite risk score is computed based on the blast radius.
 *
 * @param changedFiles - Relative paths of changed files.
 * @returns An array of {@link RiskMapEntry} objects.
 */
async function buildRiskMapFromNeo4j(
  changedFiles: string[],
): Promise<RiskMapEntry[]> {
  const graphClient = createGraphClient();

  try {
    const entries: RiskMapEntry[] = [];

    for (const file of changedFiles) {
      const dependents = await graphClient.getDependents([file]);

      const direct = dependents
        .filter((d: DependentSymbol) => d.depth === 1)
        .map((d: DependentSymbol) => d.qualifiedName);

      const indirect = dependents
        .filter((d: DependentSymbol) => d.depth > 1)
        .map((d: DependentSymbol) => d.qualifiedName);

      // Composite risk score: higher blast radius → higher risk
      const blastRadius = direct.length * 2 + indirect.length;
      const risk = Math.min(blastRadius / 20, 1); // Cap at 1.0

      entries.push({ changed: file, direct, indirect, risk });
    }

    return entries;
  } finally {
    await graphClient.close();
  }
}

/**
 * Fallback risk mapping using the LLM when Neo4j is unavailable.
 *
 * Uses the `base` tier (as declared in {@link PIPELINE_MODEL_MAP.riskMap})
 * and the risk-map prompt template to extract dependency relationships
 * from the diff itself.
 *
 * @param llm           - The LLM client instance to use.
 * @param changedFiles  - Relative paths of changed files.
 * @param diff          - The raw unified diff.
 * @param landscape     - The previously computed landscape artifact.
 * @returns An array of {@link RiskMapEntry} objects.
 */
async function buildRiskMapFromLLM(
  llm: LLMClient,
  changedFiles: string[],
  diff: string,
  landscape: LandscapeArtifact,
): Promise<RiskMapEntry[]> {
  const tier = PIPELINE_MODEL_MAP.riskMap;
  const prompt = await loadPrompt('risk-map');

  const userContent = [
    'Landscape:',
    JSON.stringify(landscape, null, 2),
    '',
    'Changed files:',
    changedFiles.join('\n'),
    '',
    'Diff:',
    diff.slice(0, 8000),
  ].join('\n');

  const result = await llm.complete(tier, prompt, userContent, {
    jsonMode: true,
  });

  const parsed = result.parsed ?? {};
  const rawEntries = parsed['entries'] ?? parsed['riskMap'] ?? [];

  if (!Array.isArray(rawEntries)) {
    return changedFiles.map((file) => ({
      changed: file,
      direct: [],
      indirect: [],
      risk: 0.1,
    }));
  }

  return rawEntries.map((entry: Record<string, unknown>, index: number) => ({
    changed: String(entry['changed'] ?? changedFiles[index] ?? 'unknown'),
    direct: toArray(entry['direct'] ?? []),
    indirect: toArray(entry['indirect'] ?? []),
    risk: Number(entry['risk'] ?? 0.1),
  }));
}

// ────────────────────────────────────────────────────────────────────────────
// Similar patterns search
// ────────────────────────────────────────────────────────────────────────────

/**
 * Searches the Qdrant vector database for code symbols semantically similar
 * to the changed code in the diff.
 *
 * The diff is truncated and embedded using the LLM embedding model, then
 * used as a query vector against the `code_symbols` collection.
 *
 * @param llm  - The LLM client instance to use.
 * @param diff - The raw unified diff.
 * @returns An array of {@link SearchResult} objects ranked by similarity.
 */
async function findSimilarPatterns(
  llm: LLMClient,
  diff: string,
): Promise<SearchResult[]> {
  const embeddingClient = createEmbeddingClient(env.QDRANT_URL);

  try {
    // Ensure the collection exists before searching
    await embeddingClient.ensureCollection('code_symbols');

    // Use the LLM client's embed method as the EmbedFn
    const embedFn = async (texts: string[]): Promise<number[][]> => {
      const result = await llm.embed(texts);
      return result.embeddings;
    };

    // Truncate diff for embedding to stay within token limits
    const queryText = diff.slice(0, 2000);

    return embeddingClient.searchByCode(queryText, embedFn, 10);
  } catch (error: unknown) {
    // Non-fatal: similar patterns are supplementary context
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[context-assembly] Similar-pattern search failed (non-fatal): ${message}`,
    );
    return [];
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Main builder
// ────────────────────────────────────────────────────────────────────────────

/**
 * Assembles the full {@link PipelineContext} for a pipeline run.
 *
 * This is the **entry point** for the Context Assembly stage. It orchestrates
 * the landscape scan, risk mapping, and similarity search sub-steps, tracking
 * the LLM budget consumed along the way.
 *
 * ### Failure handling
 * - **Landscape scan failure** → returns a minimal fallback landscape.
 * - **Neo4j unavailability** → falls back to LLM-based risk mapping.
 * - **Qdrant unavailability** → proceeds without similar patterns (non-fatal).
 *
 * @param input  - The build context input (diff, changed files, repo path).
 * @param llm    - The LLM client instance to use for LLM calls.
 * @param budget - The budget tracker to record usage.
 * @returns A fully populated {@link PipelineContext}.
 *
 * @example
 * ```ts
 * const context = await buildContext({
 *   diff: mrDiff,
 *   changedFiles: ['src/auth.ts', 'src/utils.ts'],
 *   repoPath: '/home/user/my-project',
 * }, llm, budget);
 * console.log(context.landscape.architecture);
 * console.log(context.riskMap.length);
 * ```
 */
export async function buildContext(
  input: BuildContextInput,
  llm: LLMClient,
  budget: BudgetTracker,
): Promise<PipelineContext> {
  const budgetBefore = budget.getStats().totalCostUSD;

  // ── Step 1: Landscape scan ──────────────────────────────────────────────
  let landscape: LandscapeArtifact;
  try {
    landscape = await scanLandscape(llm, input.repoPath, input.diff);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(`[context-assembly] Landscape scan failed, using fallback: ${message}`);
    landscape = {
      architecture: 'unknown',
      patterns: [],
      conventions: [],
      intentional: [],
    };
  }

  // ── Step 2: Risk map (Neo4j → LLM fallback) ────────────────────────────
  let riskMap: RiskMapEntry[];
  try {
    riskMap = await buildRiskMapFromNeo4j(input.changedFiles);
  } catch (error: unknown) {
    const message = error instanceof Error ? error.message : String(error);
    console.warn(
      `[context-assembly] Neo4j unavailable, falling back to LLM risk map: ${message}`,
    );
    riskMap = await buildRiskMapFromLLM(
      llm,
      input.changedFiles,
      input.diff,
      landscape,
    );
  }

  // ── Step 3: Similar patterns (Qdrant, non-fatal) ───────────────────────
  const similarPatterns = await findSimilarPatterns(llm, input.diff);

  // ── Step 4: Assemble context ────────────────────────────────────────────
  const budgetAfter = budget.getStats().totalCostUSD;

  return {
    landscape,
    riskMap,
    diff: input.diff,
    changedFiles: input.changedFiles,
    similarPatterns,
    budgetUsed: budgetAfter - budgetBefore,
  };
}

// ────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * Coerces an unknown value to a string array.
 *
 * Handles the common LLM output patterns where a list may be returned as:
 * - A proper `string[]`
 * - A single string (split by newlines)
 * - An array of unknown values (each stringified)
 *
 * @param value - The value to coerce.
 * @returns A string array.
 */
function toArray(value: unknown): string[] {
  if (Array.isArray(value)) {
    return value.map((v) => String(v));
  }
  if (typeof value === 'string') {
    return value
      .split('\n')
      .map((line) => line.replace(/^[-•*]\s*/, '').trim())
      .filter((line) => line.length > 0);
  }
  return [];
}
