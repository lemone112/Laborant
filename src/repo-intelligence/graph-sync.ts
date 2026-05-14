/**
 * @module repo-intelligence/graph-sync
 * @description Neo4j integration layer for persisting and querying the code
 * dependency graph. Symbol information produced by the AST indexer is synced
 * into Neo4j as nodes (`File`, `Symbol`) with typed relationships
 * (`IMPORTS`, `CALLS`, `EXPORTS_TO`). Provides both write-path (sync) and
 * read-path (dependency queries) operations.
 *
 * ## Node Model
 * - **File** — represents a source file (keyed by relative path).
 * - **Symbol** — represents a function, class, method, variable, import, or export
 *   within a file. Properties: `name`, `kind`, `file`, `startLine`, `endLine`,
 *   `signature`.
 *
 * ## Relationship Model
 * - **CONTAINS** — (File) → (Symbol): file owns the symbol.
 * - **CALLS** — (Symbol) → (Symbol): caller → callee (from `callsTo`).
 * - **IMPORTS** — (Symbol) → (File): import symbol references a target file.
 * - **EXPORTS_TO** — (Symbol) → (Symbol): export symbol links to the exported symbol.
 */

import neo4j, { type Driver, type Session, type ManagedTransaction } from 'neo4j-driver';
import type { SymbolInfo } from './ast-indexer.js';
import { env } from '../config/env.js';

// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

/**
 * A wrapped Neo4j driver with convenience methods for code-graph operations.
 * All methods are async and automatically manage session lifecycle.
 */
export interface GraphClient {
  /** The underlying Neo4j driver instance. */
  readonly driver: Driver;

  /**
   * Syncs an array of symbols into Neo4j, creating/updating nodes and
   * relationships within a single transaction.
   *
   * @param symbols - The symbols to persist.
   */
  syncSymbols(symbols: SymbolInfo[]): Promise<void>;

  /**
   * Finds all symbols that depend on the given files, traversing up to
   * `maxDepth` hops through the dependency graph.
   *
   * @param files    - List of relative file paths to start from.
   * @param maxDepth - Maximum traversal depth (default: 3).
   * @returns An array of objects describing each dependent symbol.
   */
  getDependents(files: string[], maxDepth?: number): Promise<DependentSymbol[]>;

  /**
   * Finds symbols that have a direct (single-hop) dependency on the given file.
   *
   * @param file - A single relative file path.
   * @returns An array of directly-dependent symbols.
   */
  getDirectDependents(file: string): Promise<DependentSymbol[]>;

  /**
   * Closes the Neo4j driver and releases all connections.
   * Must be called when the client is no longer needed.
   */
  close(): Promise<void>;
}

/**
 * Represents a symbol that depends on one or more of the queried files.
 * Returned by dependency-query methods.
 */
export interface DependentSymbol {
  /** The symbol's qualified name (`"file::name"`). */
  qualifiedName: string;
  /** The symbol's local name. */
  name: string;
  /** The kind of the symbol. */
  kind: string;
  /** The relative file path containing the symbol. */
  file: string;
  /** The 1-based start line. */
  startLine: number;
  /** The 1-based end line. */
  endLine: number;
  /** Number of hops from the queried file(s). */
  depth: number;
  /** The relationship type traversed to reach this symbol. */
  relationshipType: string;
}

// ────────────────────────────────────────────────────────────────────────────────
// Client factory
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Creates a new {@link GraphClient} connected to the specified Neo4j instance.
 *
 * If no connection parameters are provided, defaults are read from the
 * application's environment configuration ({@link env}).
 *
 * @param url      - Neo4j bolt/neo4j URL (default: `env.neo4jUrl`).
 * @param user     - Neo4j username (default: `env.neo4jUser`).
 * @param password - Neo4j password (default: `env.neo4jPassword`).
 * @returns A fully initialized {@link GraphClient}.
 *
 * @example
 * ```ts
 * const client = createGraphClient();
 * await client.syncSymbols(symbols);
 * const deps = await client.getDependents(['src/utils.ts']);
 * await client.close();
 * ```
 */
export function createGraphClient(
  url: string = env.NEO4J_URL,
  user: string = env.NEO4J_USER,
  password: string = env.NEO4J_PASSWORD,
): GraphClient {
  const driver: Driver = neo4j.driver(url, neo4j.auth.basic(user, password));

  // Verify connectivity on creation
  driver.verifyConnectivity().catch((err: Error) => {
    console.warn('[graph-sync] Neo4j connectivity check failed:', err.message);
  });

  return {
    driver,

    // ── syncSymbols ────────────────────────────────────────────────────────
    async syncSymbols(symbols: SymbolInfo[]): Promise<void> {
      const session: Session = driver.session();

      try {
        await session.executeWrite(async (tx: ManagedTransaction) => {
          // 1. MERGE File nodes in batch
          const files = [...new Set(symbols.map((s) => s.file))];
          await tx.run(
            `
            UNWIND $files AS filePath
            MERGE (f:File {path: filePath})
            SET f.lastIndexed = datetime()
            `,
            { files },
          );

          // 2. MERGE Symbol nodes in batch
          const symbolData = symbols.map((sym) => ({
            qualifiedName: `${sym.file}::${sym.name}`,
            name: sym.name,
            kind: sym.kind,
            file: sym.file,
            startLine: sym.startLine,
            endLine: sym.endLine,
            signature: sym.signature ?? null,
          }));
          
          // Process in batches of 500 to avoid query size limits
          const BATCH_SIZE = 500;
          for (let i = 0; i < symbolData.length; i += BATCH_SIZE) {
            const batch = symbolData.slice(i, i + BATCH_SIZE);
            await tx.run(
              `
              UNWIND $symbols AS s
              MERGE (f:File {path: s.file})
              MERGE (sym:Symbol {qualifiedName: s.qualifiedName})
              SET sym.name      = s.name,
                  sym.kind      = s.kind,
                  sym.file      = s.file,
                  sym.startLine = s.startLine,
                  sym.endLine   = s.endLine,
                  sym.signature = s.signature
              MERGE (f)-[:CONTAINS]->(sym)
              `,
              { symbols: batch },
            );
          }

          // 3. Delete stale CALLS relationships for these symbols
          const symbolQNames = symbols.map((s) => `${s.file}::${s.name}`);
          await tx.run(
            `
            UNWIND $qNames AS qName
            MATCH (s:Symbol {qualifiedName: qName})-[r:CALLS]->()
            DELETE r
            `,
            { qNames: symbolQNames },
          );

          // 4. CREATE CALLS relationships in batch
          const callsData: Array<{ callerQName: string; callee: string; calleeSimpleName: string }> = [];
          for (const sym of symbols) {
            if (sym.kind === 'import' || sym.kind === 'export') continue;
            if (sym.callsTo.length === 0) continue;
            const callerQName = `${sym.file}::${sym.name}`;
            for (const callee of sym.callsTo) {
              callsData.push({
                callerQName,
                callee,
                calleeSimpleName: callee.includes('.') ? callee.split('.').pop()! : callee,
              });
            }
          }

          for (let i = 0; i < callsData.length; i += BATCH_SIZE) {
            const batch = callsData.slice(i, i + BATCH_SIZE);
            await tx.run(
              `
              UNWIND $calls AS c
              MATCH (caller:Symbol {qualifiedName: c.callerQName})
              MATCH (callee:Symbol)
              WHERE callee.qualifiedName = c.callee
                 OR callee.name = c.calleeSimpleName
              MERGE (caller)-[:CALLS]->(callee)
              `,
              { calls: batch },
            );
          }

          // 5. CREATE IMPORTS relationships in batch
          const importsData: Array<{ importerQName: string; targetFile: string }> = [];
          for (const sym of symbols) {
            if (sym.kind !== 'import') continue;
            const targetFile = resolveImportTarget(sym.name);
            if (targetFile) {
              importsData.push({
                importerQName: `${sym.file}::${sym.name}`,
                targetFile,
              });
            }
          }

          if (importsData.length > 0) {
            await tx.run(
              `
              UNWIND $imports AS imp
              MATCH (s:Symbol {qualifiedName: imp.importerQName})
              MERGE (f:File {path: imp.targetFile})
              MERGE (s)-[:IMPORTS]->(f)
              `,
              { imports: importsData },
            );
          }

          // 6. CREATE EXPORTS_TO relationships in batch
          const exportsData = symbols
            .filter((s) => s.kind === 'export')
            .map((s) => ({
              exporterQName: `${s.file}::${s.name}`,
              file: s.file,
            }));

          if (exportsData.length > 0) {
            await tx.run(
              `
              UNWIND $exports AS exp
              MATCH (exportSym:Symbol {qualifiedName: exp.exporterQName})
              MATCH (targetSym:Symbol)
              WHERE targetSym.file = exp.file
                AND targetSym.kind <> 'export'
                AND exportSym.name CONTAINS targetSym.name
              MERGE (exportSym)-[:EXPORTS_TO]->(targetSym)
              `,
              { exports: exportsData },
            );
          }
        });

        console.log(`[graph-sync] Synced ${symbols.length} symbols to Neo4j`);
      } catch (err) {
        console.error('[graph-sync] Failed to sync symbols to Neo4j:', err);
        throw err;
      } finally {
        await session.close();
      }
    },

    // ── getDependents ──────────────────────────────────────────────────────
    async getDependents(
      files: string[],
      maxDepth: number = 3,
    ): Promise<DependentSymbol[]> {
      // Validate maxDepth to prevent Cypher injection via string interpolation
      const safeDepth = Math.max(1, Math.min(10, Math.floor(maxDepth)));

      const session: Session = driver.session();

      try {
        const result = await session.run(
          `
          MATCH (f:File)
          WHERE f.path IN $files
          MATCH path = (dependent:Symbol)-[:CALLS|IMPORTS*1..${safeDepth}]->(f)-[:CONTAINS]->(target:Symbol)
          WITH dependent, target, relationships(path) AS rels, length(path) AS depth
          RETURN dependent.qualifiedName AS qualifiedName,
                 dependent.name           AS name,
                 dependent.kind           AS kind,
                 dependent.file           AS file,
                 dependent.startLine      AS startLine,
                 dependent.endLine        AS endLine,
                 depth                    AS depth,
                 type(last(rels))         AS relationshipType
          ORDER BY depth ASC, qualifiedName ASC
          `,
          { files },
        );

        return result.records.map((record) => ({
          qualifiedName: record.get('qualifiedName'),
          name: record.get('name'),
          kind: record.get('kind'),
          file: record.get('file'),
          startLine: record.get('startLine'),
          endLine: record.get('endLine'),
          depth: record.get('depth').toNumber?.() ?? Number(record.get('depth')),
          relationshipType: record.get('relationshipType'),
        }));
      } catch (err) {
        console.error('[graph-sync] getDependents query failed:', err);
        throw err;
      } finally {
        await session.close();
      }
    },

    // ── getDirectDependents ────────────────────────────────────────────────
    async getDirectDependents(file: string): Promise<DependentSymbol[]> {
      const session: Session = driver.session();

      try {
        const result = await session.run(
          `
          MATCH (f:File {path: $file})<-[:CONTAINS]-(target:Symbol)
          MATCH (dependent:Symbol)-[r:CALLS|IMPORTS]->(target)
          RETURN dependent.qualifiedName AS qualifiedName,
                 dependent.name           AS name,
                 dependent.kind           AS kind,
                 dependent.file           AS file,
                 dependent.startLine      AS startLine,
                 dependent.endLine        AS endLine,
                 1                        AS depth,
                 type(r)                  AS relationshipType
          ORDER BY qualifiedName ASC
          `,
          { file },
        );

        return result.records.map((record) => ({
          qualifiedName: record.get('qualifiedName'),
          name: record.get('name'),
          kind: record.get('kind'),
          file: record.get('file'),
          startLine: record.get('startLine'),
          endLine: record.get('endLine'),
          depth: 1,
          relationshipType: record.get('relationshipType'),
        }));
      } catch (err) {
        console.error('[graph-sync] getDirectDependents query failed:', err);
        throw err;
      } finally {
        await session.close();
      }
    },

    // ── close ──────────────────────────────────────────────────────────────
    async close(): Promise<void> {
      await driver.close();
      console.log('[graph-sync] Neo4j driver closed');
    },
  };
}

// ────────────────────────────────────────────────────────────────────────────────
// Helpers
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Best-effort extraction of a target file path from an import statement's
 * raw text. Handles common import syntax across supported languages:
 *
 * - TS/TSX: `import { foo } from './utils'` → `./utils.ts`
 * - Python: `from package.module import foo` → `package/module.py`
 * - Go:     `import "fmt"` → `fmt`
 * - Rust:   `use crate::module::item` → `crate/module.rs`
 *
 * @param importText - The full text of the import node.
 * @returns A best-guess file path string, or `undefined` if it cannot be resolved.
 */
function resolveImportTarget(importText: string): string | undefined {
  // TypeScript: extract from '...' or "..."
  const tsMatch = importText.match(/from\s+['"]([^'"]+)['"]/);
  if (tsMatch) {
    let target = tsMatch[1]!;
    if (target.startsWith('.')) {
      // Relative import — normalize extension
      if (!target.endsWith('.ts') && !target.endsWith('.tsx')) {
        target += '.ts';
      }
      return target;
    }
    return target;
  }

  // Python: from package.module import ...
  const pyMatch = importText.match(/from\s+([\w.]+)/);
  if (pyMatch) {
    return `${pyMatch[1]!.replace(/\./g, '/')}.py`;
  }

  // Go: import "package"
  const goMatch = importText.match(/import\s+["`]([^"`]+)/);
  if (goMatch) {
    return goMatch[1];
  }

  // Rust: use crate::module::item
  const rustMatch = importText.match(/use\s+([\w:]+)/);
  if (rustMatch) {
    return `${rustMatch[1]!.replace(/::/g, '/')}.rs`;
  }

  return undefined;
}
