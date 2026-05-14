/**
 * @module repo-intelligence/embedding-sync
 * @description Qdrant integration layer for semantic code search. Symbol
 * information produced by the AST indexer is embedded using a caller-supplied
 * embedding function and upserted into a Qdrant vector collection. Provides
 * both write-path (sync) and read-path (similarity search) operations, plus
 * incremental-update support via per-file deletion.
 *
 * ## Point Schema
 * Each Qdrant point corresponds to one {@link SymbolInfo}:
 * - **ID** — deterministic UUID v5 derived from `"file::name"`.
 * - **Vector** — embedding of the symbol's signature + contextual metadata.
 * - **Payload** — `name`, `kind`, `file`, `startLine`, `endLine`, `signature`.
 */

import { QdrantClient } from '@qdrant/js-client-rest';
import type { SymbolInfo } from './ast-indexer.js';
import { env } from '../config/env.js';
import { createHash } from 'node:crypto';

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

/**
 * A function that accepts an array of text strings and returns a promise
 * resolving to a 2-D array of embedding vectors (one vector per input string).
 *
 * Typically backed by OpenAI's `text-embedding-3-small` or a self-hosted model.
 */
export type EmbedFn = (texts: string[]) => Promise<number[][]>;

/**
 * A wrapped Qdrant client with convenience methods for code-embedding
 * operations. All methods are async and manage the Qdrant collection lifecycle.
 */
export interface EmbeddingClient {
  /** The underlying Qdrant client instance. */
  readonly client: QdrantClient;

  /** The name of the active collection. */
  readonly collectionName: string;

  /**
   * Creates the vector collection if it does not already exist.
   * Uses cosine distance by default.
   *
   * @param collectionName - The collection to create.
   * @param dim            - Vector dimensionality (default: from env or 1536).
   */
  ensureCollection(collectionName: string, dim?: number): Promise<void>;

  /**
   * Embeds each symbol's signature + context using the supplied `embedFn`,
   * then upserts all points into the collection in batches.
   *
   * @param symbols - The symbols to embed and upsert.
   * @param embedFn - A function that produces embedding vectors from text.
   */
  syncEmbeddings(
    symbols: SymbolInfo[],
    embedFn: EmbedFn,
  ): Promise<void>;

  /**
   * Performs a vector similarity search against the collection.
   *
   * @param queryEmbedding - The pre-computed query embedding vector.
   * @param limit          - Maximum number of results to return (default: 10).
   * @param filter         - Optional Qdrant filter object to narrow results.
   * @returns An array of scored points from Qdrant.
   */
  searchSimilar(
    queryEmbedding: number[],
    limit?: number,
    filter?: object,
  ): Promise<SearchResult[]>;

  /**
   * Convenience method: embeds a natural-language code query, then searches
   * for similar symbols.
   *
   * @param query   - The search query string (e.g. "function that validates email").
   * @param embedFn - A function that produces embedding vectors from text.
   * @param limit   - Maximum number of results to return (default: 10).
   * @returns An array of scored points from Qdrant.
   */
  searchByCode(
    query: string,
    embedFn: EmbedFn,
    limit?: number,
  ): Promise<SearchResult[]>;

  /**
   * Removes all embeddings belonging to a specific file. Useful for
   * incremental re-indexing: delete stale points before upserting new ones.
   *
   * @param fileName - The relative file path whose points should be removed.
   */
  deleteByFile(fileName: string): Promise<void>;
}

/**
 * A simplified search result representing a scored point from Qdrant.
 */
export interface SearchResult {
  /** The point's unique ID. */
  id: string;
  /** Similarity score (higher is more similar for cosine distance). */
  score: number;
  /** The stored payload for the matched point. */
  payload: Record<string, unknown>;
}

// ────────────────────────────────────────────────────────────────────────────────
// Deterministic point IDs
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Generates a deterministic UUID v5 for a symbol, suitable for use
 * as a Qdrant point ID. Uses SHA-1 hashing (UUID v5 algorithm) to
 * ensure the same symbol always maps to the same point ID.
 *
 * @param qualifiedName - The fully-qualified symbol name (`"file::name"`).
 * @returns A deterministic UUID v5 string.
 */
const UUID_V5_NAMESPACE = '6ba7b810-9dad-11d1-80b4-00c04fd430c8'; // DNS namespace

function deterministicId(qualifiedName: string): string {
  const hash = createHash('sha1')
    .update(UUID_V5_NAMESPACE + qualifiedName)
    .digest('hex');

  // Format as UUID v5 (version bits = 0101, variant bits = 10)
  return [
    hash.slice(0, 8),
    hash.slice(8, 12),
    '5' + hash.slice(13, 16), // version 5
    ((parseInt(hash.slice(16, 18), 16) & 0x3f) | 0x80).toString(16).padStart(2, '0') + hash.slice(18, 20), // variant
    hash.slice(20, 32),
  ].join('-');
}

// ────────────────────────────────────────────────────────────────────────────────
// Client factory
// ────────────────────────────────────────────────────────────────────────────────

/** Default collection name for code-symbol embeddings. */
const DEFAULT_COLLECTION = 'code_symbols';

/** Batch size for upsert operations. */
const UPSERT_BATCH_SIZE = 100;

/** Batch size for embedding calls. */
const EMBED_BATCH_SIZE = 50;

/**
 * Creates a new {@link EmbeddingClient} connected to the specified Qdrant
 * instance.
 *
 * If no URL is provided, the default is read from the application's
 * environment configuration ({@link env}).
 *
 * @param url - Qdrant REST API URL (default: `env.qdrantUrl`).
 * @returns A fully initialized {@link EmbeddingClient}.
 *
 * @example
 * ```ts
 * const client = createEmbeddingClient();
 * await client.ensureCollection('code_symbols', 1536);
 * await client.syncEmbeddings(symbols, myEmbedFn);
 * const results = await client.searchByCode('validate email', myEmbedFn, 5);
 * ```
 */
export function createEmbeddingClient(url: string = env.QDRANT_URL): EmbeddingClient {
  const client = new QdrantClient({ url });

  return {
    client,
    collectionName: DEFAULT_COLLECTION,

    // ── ensureCollection ──────────────────────────────────────────────────
    async ensureCollection(
      collectionName: string = DEFAULT_COLLECTION,
      dim: number = env.LLM_EMBEDDING_DIM,
    ): Promise<void> {
      const collections = await client.getCollections();
      const exists = collections.collections.some(
        (c) => c.name === collectionName,
      );

      if (!exists) {
        await client.createCollection(collectionName, {
          vectors: {
            size: dim,
            distance: 'Cosine',
          },
        });
        console.log(
          `[embedding-sync] Created collection "${collectionName}" (dim=${dim})`,
        );
      } else {
        console.log(
          `[embedding-sync] Collection "${collectionName}" already exists`,
        );
      }
    },

    // ── syncEmbeddings ────────────────────────────────────────────────────
    async syncEmbeddings(
      symbols: SymbolInfo[],
      embedFn: EmbedFn,
    ): Promise<void> {
      if (symbols.length === 0) {
        console.log('[embedding-sync] No symbols to embed');
        return;
      }

      // Filter to only embeddable symbols (skip raw import/export statements)
      const embeddable = symbols.filter(
        (s) => s.kind !== 'import' && s.kind !== 'export',
      );

      if (embeddable.length === 0) {
        console.log('[embedding-sync] No embeddable symbols after filtering');
        return;
      }

      // Build text representations for embedding
      const texts = embeddable.map(buildEmbeddingText);
      const allEmbeddings: number[][] = [];

      // Embed in batches to respect API rate limits
      for (let i = 0; i < texts.length; i += EMBED_BATCH_SIZE) {
        const batch = texts.slice(i, i + EMBED_BATCH_SIZE);
        const embeddings = await embedFn(batch);
        allEmbeddings.push(...embeddings);
        console.log(
          `[embedding-sync] Embedded batch ${Math.floor(i / EMBED_BATCH_SIZE) + 1}/${Math.ceil(texts.length / EMBED_BATCH_SIZE)}`,
        );
      }

      // Build points for upsert
      const points = embeddable.map((sym, idx) => {
        const qualifiedName = `${sym.file}::${sym.name}`;
        return {
          id: deterministicId(qualifiedName),
          vector: allEmbeddings[idx]!,
          payload: {
            name: sym.name,
            kind: sym.kind,
            file: sym.file,
            startLine: sym.startLine,
            endLine: sym.endLine,
            signature: sym.signature ?? null,
            qualifiedName,
            callsTo: sym.callsTo,
            calledBy: sym.calledBy,
          } as Record<string, unknown>,
        };
      });

      // Upsert in batches
      for (let i = 0; i < points.length; i += UPSERT_BATCH_SIZE) {
        const batch = points.slice(i, i + UPSERT_BATCH_SIZE);
        await client.upsert(DEFAULT_COLLECTION, {
          wait: true,
          points: batch,
        });
        console.log(
          `[embedding-sync] Upserted batch ${Math.floor(i / UPSERT_BATCH_SIZE) + 1}/${Math.ceil(points.length / UPSERT_BATCH_SIZE)}`,
        );
      }

      console.log(
        `[embedding-sync] Synced ${points.length} symbol embeddings to Qdrant`,
      );
    },

    // ── searchSimilar ─────────────────────────────────────────────────────
    async searchSimilar(
      queryEmbedding: number[],
      limit: number = 10,
      filter?: object,
    ): Promise<SearchResult[]> {
      const results = await client.search(DEFAULT_COLLECTION, {
        vector: queryEmbedding,
        limit,
        with_payload: true,
        ...(filter ? { filter } : {}),
      });

      return results.map((point) => ({
        id: String(point.id),
        score: point.score ?? 0,
        payload: (point.payload ?? {}) as Record<string, unknown>,
      }));
    },

    // ── searchByCode ──────────────────────────────────────────────────────
    async searchByCode(
      query: string,
      embedFn: EmbedFn,
      limit: number = 10,
    ): Promise<SearchResult[]> {
      const [queryEmbedding] = await embedFn([query]);
      if (!queryEmbedding) {
        throw new Error('[embedding-sync] Failed to embed search query');
      }
      return this.searchSimilar(queryEmbedding, limit);
    },

    // ── deleteByFile ──────────────────────────────────────────────────────
    async deleteByFile(fileName: string): Promise<void> {
      await client.delete(DEFAULT_COLLECTION, {
        wait: true,
        filter: {
          must: [
            {
              key: 'file',
              match: {
                value: fileName,
              },
            },
          ],
        },
      });
      console.log(
        `[embedding-sync] Deleted embeddings for file: ${fileName}`,
      );
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Builds a text representation of a symbol suitable for embedding.
 * Combines the symbol's kind, name, signature, and call-graph context
 * to produce a rich semantic representation.
 *
 * The format is designed to maximize searchability:
 * ```
 * [kind] name signature
 * Calls: foo, bar
 * Called by: baz
 * ```
 *
 * @param sym - The symbol to build embedding text for.
 * @returns A string representation optimized for semantic embedding.
 */
function buildEmbeddingText(sym: SymbolInfo): string {
  const parts: string[] = [];

  // Kind and name
  parts.push(`[${sym.kind}] ${sym.name}`);

  // Signature (parameters, return type)
  if (sym.signature) {
    parts.push(sym.signature);
  }

  // Call context — what this symbol calls
  if (sym.callsTo.length > 0) {
    parts.push(`Calls: ${sym.callsTo.join(', ')}`);
  }

  // Call context — what calls this symbol
  if (sym.calledBy.length > 0) {
    parts.push(`Called by: ${sym.calledBy.join(', ')}`);
  }

  // File location hint
  parts.push(`In: ${sym.file}:${sym.startLine}-${sym.endLine}`);

  return parts.join('\n');
}
