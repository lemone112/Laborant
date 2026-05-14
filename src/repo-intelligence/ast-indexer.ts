/**
 * @module repo-intelligence/ast-indexer
 * @description AST-based code indexer using tree-sitter to extract symbol information
 * from source files across multiple programming languages. Builds a complete call
 * graph by performing a two-pass analysis: first extracting symbols and their
 * outgoing call references, then resolving those references into incoming-call
 * (calledBy) edges.
 *
 * Supported languages: TypeScript/TSX, Python, Go, Rust.
 */

import Parser from 'tree-sitter';
import TypeScript from 'tree-sitter-typescript';
import Python from 'tree-sitter-python';
import Go from 'tree-sitter-go';
import Rust from 'tree-sitter-rust';
import { glob } from 'node:fs/promises';
import { readFile } from 'node:fs/promises';
import { join, relative } from 'node:path';

// ────────────────────────────────────────────────────────────────────────────────
// Parser init guard
// ────────────────────────────────────────────────────────────────────────────────


// ────────────────────────────────────────────────────────────────────────────────
// Types
// ────────────────────────────────────────────────────────────────────────────────

/**
 * The kind of a symbol extracted from source code.
 * - `function` — top-level function declaration or expression
 * - `class`    — class / struct / type declaration
 * - `method`   — method defined within a class / impl block
 * - `variable` — variable declaration (const, let, var, etc.)
 * - `import`   — import / use statement
 * - `export`   — re-export or named export
 */
export type SymbolKind =
  | 'function'
  | 'class'
  | 'method'
  | 'variable'
  | 'import'
  | 'export';

/**
 * Represents a single symbol (function, class, method, variable, import, or export)
 * extracted from a source file during AST indexing.
 */
export interface SymbolInfo {
  /** The local identifier / name of the symbol. */
  name: string;
  /** The category of the symbol. */
  kind: SymbolKind;
  /** Relative file path from the repository root. */
  file: string;
  /** The 1-based line number where the symbol starts. */
  startLine: number;
  /** The 1-based line number where the symbol ends. */
  endLine: number;
  /** Optional signature string (e.g. function parameters and return type). */
  signature?: string;
  /**
   * Qualified names of symbols that this symbol calls.
   * Populated during the first (extraction) pass.
   */
  callsTo: string[];
  /**
   * Qualified names of symbols that call this symbol.
   * Populated during the second (resolve-call-graph) pass.
   */
  calledBy: string[];
}

/**
 * A map from a qualified symbol name (e.g. `"src/utils.ts::formatDate"`)
 * to its `SymbolInfo`. Used internally for fast lookup during call-graph
 * resolution.
 */
type SymbolMap = Map<string, SymbolInfo>;

// ────────────────────────────────────────────────────────────────────────────────
// Language selection
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Selects the appropriate tree-sitter grammar based on the file extension.
 *
 * @param file - The file path (only the extension is inspected).
 * @returns A tree-sitter language grammar object.
 * @throws {Error} If the file extension is not supported.
 *
 * @example
 * ```ts
 * const lang = selectLanguage('src/app.tsx'); // → TypeScript TSX grammar
 * ```
 */
export function selectLanguage(file: string): any {
  const ext = file.split('.').pop()?.toLowerCase();

  switch (ext) {
    case 'ts':
      return TypeScript.typescript;
    case 'tsx':
      return TypeScript.tsx;
    case 'py':
      return Python;
    case 'go':
      return Go;
    case 'rs':
      return Rust;
    default:
      throw new Error(`Unsupported file extension: .${ext ?? 'unknown'} (${file})`);
  }
}

/**
 * Checks whether a file extension is supported by the indexer.
 *
 * @param file - The file path to check.
 * @returns `true` if the extension maps to a known grammar, `false` otherwise.
 */
function isSupportedFile(file: string): boolean {
  const ext = file.split('.').pop()?.toLowerCase();
  return ['ts', 'tsx', 'py', 'go', 'rs'].includes(ext ?? '');
}

// ────────────────────────────────────────────────────────────────────────────────
// Single-file indexing
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Parses a single source file and extracts all symbols (functions, classes,
 * methods, variables, imports, and exports) along with their call references.
 *
 * The parser is configured with the grammar returned by {@link selectLanguage}
 * based on the file's extension.
 *
 * @param filePath - The relative file path (used as the `file` field on symbols).
 * @param content - The full source text of the file.
 * @returns An array of {@link SymbolInfo} objects found in the file.
 *
 * @example
 * ```ts
 * const symbols = indexFile('src/utils.ts', fs.readFileSync('src/utils.ts', 'utf8'));
 * ```
 */
export async function indexFile(filePath: string, content: string): Promise<SymbolInfo[]> {
  const language = selectLanguage(filePath);
  const parser = new Parser();
  parser.setLanguage(language);

  const tree = parser.parse(content);
  const symbols: SymbolInfo[] = [];

  extractSymbols(tree.rootNode, filePath, symbols);

  return symbols;
}

// ────────────────────────────────────────────────────────────────────────────────
// Recursive symbol extraction
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Recursively walks a tree-sitter AST node and extracts symbol information.
 *
 * Handles the following node types (across supported languages):
 * - **Function declarations** → `kind: 'function'`
 * - **Class / struct / type declarations** → `kind: 'class'`
 * - **Method definitions** (inside class bodies) → `kind: 'method'`
 * - **Variable declarations** → `kind: 'variable'`
 * - **Import statements** → `kind: 'import'`
 * - **Export statements** → `kind: 'export'`
 * - **Call expressions** → adds callee name to parent function's `callsTo`
 *
 * @param node     - The current tree-sitter AST node.
 * @param file     - The relative file path for the symbols.
 * @param symbols  - The accumulator array for extracted symbols.
 * @param parentFn - (internal) The qualified name of the enclosing function, used
 *                   to attribute call expressions to the correct caller.
 */
export function extractSymbols(
  node: any,
  file: string,
  symbols: SymbolInfo[],
  parentFn?: string,
): void {
  if (!node) return;

  const type: string = node.type;

  // ── Function declarations ─────────────────────────────────────────────────
  if (
    type === 'function_declaration' ||
    type === 'function' ||
    type === 'arrow_function' ||
    type === 'function_definition' // Python & Go
  ) {
    const nameNode = node.childForFieldName('name')
      ?? node.children?.find((c: any) => c.type === 'identifier')
      ?? node.children?.find((c: any) => c.type === 'property_identifier');
    const name = nameNode?.text ?? '<anonymous>';
    const qualifiedName = `${file}::${name}`;
    const parametersNode = node.childForFieldName('parameters');
    const signature = parametersNode?.text ?? undefined;

    const symbol: SymbolInfo = {
      name,
      kind: 'function',
      file,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature,
      callsTo: [],
      calledBy: [],
    };
    symbols.push(symbol);

    // Recurse into the body, passing the qualified name so call expressions
    // inside are attributed to this function.
    const bodyNode = node.childForFieldName('body');
    if (bodyNode) {
      extractSymbols(bodyNode, file, symbols, qualifiedName);
    }
    return;
  }

  // ── Class / struct / type declarations ─────────────────────────────────────
  if (
    type === 'class_declaration' ||
    type === 'class_definition' || // Python
    type === 'struct_item' || // Rust
    type === 'type_declaration'
  ) {
    const nameNode =
      node.childForFieldName('name') ??
      node.children?.find((c: any) => c.type === 'identifier') ??
      node.children?.find((c: any) => c.type === 'type_identifier');
    const name = nameNode?.text ?? '<anonymous-class>';
    const qualifiedName = `${file}::${name}`;

    const symbol: SymbolInfo = {
      name,
      kind: 'class',
      file,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: undefined,
      callsTo: [],
      calledBy: [],
    };
    symbols.push(symbol);

    // Recurse into the class body to find methods.
    const bodyNode =
      node.childForFieldName('body') ??
      node.childForFieldName('members') ??
      node.children?.find((c: any) => c.type === 'declaration_list' || c.type === 'field_declaration_list');
    if (bodyNode) {
      extractSymbols(bodyNode, file, symbols, qualifiedName);
    }
    return;
  }

  // ── Method definitions (inside class bodies) ──────────────────────────────
  if (
    type === 'method_definition' ||
    type === 'function_definition' ||
    type === 'function_item' || // Rust
    type === 'impl_item' // Rust impl blocks contain function_items
  ) {
    // For Rust impl_item, we recurse into its children
    if (type === 'impl_item') {
      for (const child of node.children ?? []) {
        extractSymbols(child, file, symbols, parentFn);
      }
      return;
    }

    const nameNode =
      node.childForFieldName('name') ??
      node.children?.find((c: any) => c.type === 'identifier' || c.type === 'property_identifier');
    const name = nameNode?.text ?? '<anonymous-method>';
    const qualifiedName = parentFn ? `${parentFn}.${name}` : `${file}::${name}`;
    const parametersNode = node.childForFieldName('parameters');
    const signature = parametersNode?.text ?? undefined;

    const symbol: SymbolInfo = {
      name,
      kind: 'method',
      file,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature,
      callsTo: [],
      calledBy: [],
    };
    symbols.push(symbol);

    const bodyNode = node.childForFieldName('body');
    if (bodyNode) {
      extractSymbols(bodyNode, file, symbols, qualifiedName);
    }
    return;
  }

  // ── Variable declarations ─────────────────────────────────────────────────
  if (
    type === 'variable_declarator' ||
    type === 'lexical_declaration' ||
    type === 'variable_declaration' ||
    type === 'assignment' ||
    type === 'let_statement' || // Rust let
    type === 'short_var_declaration' // Go :=
  ) {
    const nameNode =
      node.childForFieldName('name') ??
      node.children?.find((c: any) => c.type === 'identifier');

    // Skip if we can't find a name (e.g. destructuring patterns)
    if (nameNode) {
      const name = nameNode.text;
      const symbol: SymbolInfo = {
        name,
        kind: 'variable',
        file,
        startLine: node.startPosition.row + 1,
        endLine: node.endPosition.row + 1,
        signature: undefined,
        callsTo: [],
        calledBy: [],
      };
      symbols.push(symbol);
    }

    // Recurse into value/initializer to capture call expressions
    const valueNode =
      node.childForFieldName('value') ??
      node.childForFieldName('initializer');
    if (valueNode) {
      extractSymbols(valueNode, file, symbols, parentFn);
    }
    // Also recurse into remaining children
    for (const child of node.children ?? []) {
      if (child !== nameNode && child !== valueNode) {
        extractSymbols(child, file, symbols, parentFn);
      }
    }
    return;
  }

  // ── Import statements ─────────────────────────────────────────────────────
  if (
    type === 'import_statement' ||
    type === 'import_declaration' ||
    type === 'use_declaration' || // Rust
    type === 'import_from_statement' // Python
  ) {
    const text = node.text;
    const symbol: SymbolInfo = {
      name: text,
      kind: 'import',
      file,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: undefined,
      callsTo: [],
      calledBy: [],
    };
    symbols.push(symbol);
    return;
  }

  // ── Export statements ─────────────────────────────────────────────────────
  if (
    type === 'export_statement' ||
    type === 'export_default_declaration' ||
    type === 'export_named_declaration' ||
    type === 'export_all_declaration'
  ) {
    const text = node.text;
    const symbol: SymbolInfo = {
      name: text,
      kind: 'export',
      file,
      startLine: node.startPosition.row + 1,
      endLine: node.endPosition.row + 1,
      signature: undefined,
      callsTo: [],
      calledBy: [],
    };
    symbols.push(symbol);

    // Recurse into exported item to capture the actual declaration
    for (const child of node.children ?? []) {
      extractSymbols(child, file, symbols, parentFn);
    }
    return;
  }

  // ── Call expressions ──────────────────────────────────────────────────────
  if (type === 'call_expression' || type === 'call') {
    if (parentFn) {
      const calleeName = extractCalleeName(node);
      if (calleeName) {
        // Find the parent function symbol and add the call reference
        const parentSymbol = symbols.find(
          (s) =>
            (s.kind === 'function' || s.kind === 'method') &&
            `${s.file}::${s.name}` === parentFn,
        ) ?? symbols.find(
          (s) =>
            (s.kind === 'function' || s.kind === 'method') &&
            parentFn.endsWith(`.${s.name}`) &&
            parentFn.startsWith(s.file),
        );
        if (parentSymbol && !parentSymbol.callsTo.includes(calleeName)) {
          parentSymbol.callsTo.push(calleeName);
        }
      }
    }

    // Recurse into call arguments
    const argsNode = node.childForFieldName('arguments');
    if (argsNode) {
      extractSymbols(argsNode, file, symbols, parentFn);
    }
    return;
  }

  // ── Default: recurse into children ────────────────────────────────────────
  for (const child of node.children ?? []) {
    extractSymbols(child, file, symbols, parentFn);
  }
}

/**
 * Extracts the callee name from a call expression node.
 * Handles simple identifiers (`foo()`), member expressions (`obj.method()`),
 * and property access chains (`a.b.c()`).
 *
 * @param callNode - A tree-sitter node of type `call_expression`.
 * @returns The callee name as a string, or `undefined` if it cannot be determined.
 */
function extractCalleeName(callNode: any): string | undefined {
  const funcNode = callNode.childForFieldName('function');
  if (!funcNode) return undefined;

  // Simple identifier call: foo()
  if (funcNode.type === 'identifier') {
    return funcNode.text;
  }

  // Member expression call: obj.method(), this.method(), etc.
  if (funcNode.type === 'member_expression' || funcNode.type === 'field_expression') {
    const objNode = funcNode.childForFieldName('object');
    const fieldNode = funcNode.childForFieldName('field');

    if (fieldNode) {
      const fieldName = fieldNode.text;
      if (objNode && objNode.type === 'identifier') {
        return `${objNode.text}.${fieldName}`;
      }
      // Nested member expression: a.b.c()
      if (objNode && (objNode.type === 'member_expression' || objNode.type === 'field_expression')) {
        const objName = extractCalleeName({ childForFieldName: (f: string) => f === 'function' ? objNode : null } as any);
        return objName ? `${objName}.${fieldName}` : fieldName;
      }
      return fieldName;
    }
  }

  // Fallback: use the text of the function node, truncated
  return funcNode.text.length > 80 ? undefined : funcNode.text;
}

// ────────────────────────────────────────────────────────────────────────────────
// Repository-level indexing
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Indexes all supported source files in a repository, extracting symbols and
 * resolving the call graph across the entire codebase.
 *
 * The process is:
 * 1. Glob all source files with supported extensions.
 * 2. Parse each file individually via {@link indexFile}.
 * 3. Run {@link resolveCallGraph} to populate `calledBy` fields.
 *
 * @param repoPath - Absolute path to the repository root.
 * @returns A flat array of all {@link SymbolInfo} objects found across the repo.
 *
 * @example
 * ```ts
 * const allSymbols = await indexRepository('/home/user/my-project');
 * console.log(`Indexed ${allSymbols.length} symbols`);
 * ```
 */
export async function indexRepository(repoPath: string): Promise<SymbolInfo[]> {
  const allSymbols: SymbolInfo[] = [];

  // Patterns to skip
  const skipPatterns = /node_modules|\.git|\/dist\/|\/build\/|\/vendor\/|__pycache__|\.next/;

  // Glob patterns for supported languages
  const patterns = [
    '**/*.ts',
    '**/*.tsx',
    '**/*.py',
    '**/*.go',
    '**/*.rs',
  ];

  // Collect all matching file paths
  const filePaths: string[] = [];
  for (const pattern of patterns) {
    const globIter = glob(join(repoPath, pattern));
    for await (const entry of globIter) {
      // Filter out unwanted directories
      if (!skipPatterns.test(entry)) {
        filePaths.push(entry);
      }
    }
  }

  // Deduplicate
  const uniquePaths = [...new Set(filePaths)];

  // Index each file
  for (const absPath of uniquePaths) {
    if (!isSupportedFile(absPath)) continue;

    const relPath = relative(repoPath, absPath);
    let content: string;

    try {
      content = await readFile(absPath, 'utf-8');
    } catch (err) {
      console.warn(`[ast-indexer] Skipping unreadable file: ${absPath}`, err);
      continue;
    }

    try {
      const fileSymbols = await indexFile(relPath, content);
      allSymbols.push(...fileSymbols);
    } catch (err) {
      console.warn(`[ast-indexer] Failed to index: ${relPath}`, err);
    }
  }

  // Second pass: resolve the call graph
  resolveCallGraph(allSymbols);

  return allSymbols;
}

// ────────────────────────────────────────────────────────────────────────────────
// Call-graph resolution
// ────────────────────────────────────────────────────────────────────────────────

/**
 * Performs the second pass of indexing: for each symbol's `callsTo` list,
 * finds the target symbol and adds the caller's qualified name to the target's
 * `calledBy` array.
 *
 * Matching heuristics:
 * 1. **Exact qualified name match**: `"file::name"` matches a symbol with
 *    `file === filePath` and `name === symbolName`.
 * 2. **Name-only match**: If no qualified match is found, falls back to matching
 *    by `name` alone (useful when call sites omit the module path).
 *
 * @param symbols - The flat array of all symbols (mutated in-place to fill `calledBy`).
 *
 * @example
 * ```ts
 * const symbols = indexFile('utils.ts', source);
 * // ... index more files ...
 * resolveCallGraph(allSymbols);
 * // Now each symbol.calledBy is populated
 * ```
 */
export function resolveCallGraph(symbols: SymbolInfo[]): void {
  // Build lookup maps for fast resolution
  const qualifiedMap: SymbolMap = new Map();
  const nameMap: Map<string, SymbolInfo[]> = new Map();

  for (const sym of symbols) {
    if (sym.kind === 'import' || sym.kind === 'export') continue;

    const qName = `${sym.file}::${sym.name}`;
    qualifiedMap.set(qName, sym);

    const existing = nameMap.get(sym.name) ?? [];
    existing.push(sym);
    nameMap.set(sym.name, existing);
  }

  // Resolve calls
  for (const sym of symbols) {
    if (sym.kind === 'import' || sym.kind === 'export') continue;
    if (sym.callsTo.length === 0) continue;

    const callerQName = `${sym.file}::${sym.name}`;

    for (const callee of sym.callsTo) {
      const target = findTargetSymbol(callee, sym.file, qualifiedMap, nameMap);
      if (target && target !== sym) {
        // Add the caller to the callee's calledBy (avoid duplicates)
        if (!target.calledBy.includes(callerQName)) {
          target.calledBy.push(callerQName);
        }
      }
    }
  }
}

/**
 * Resolves a callee name to a target symbol using progressively looser matching.
 *
 * @param callee        - The callee name from `callsTo` (may be qualified or simple).
 * @param sourceFile    - The file of the caller (used for same-file resolution).
 * @param qualifiedMap  - Map of fully-qualified names to symbols.
 * @param nameMap       - Map of simple names to arrays of symbols.
 * @returns The matching `SymbolInfo`, or `undefined` if no match is found.
 */
function findTargetSymbol(
  callee: string,
  sourceFile: string,
  qualifiedMap: SymbolMap,
  nameMap: Map<string, SymbolInfo[]>,
): SymbolInfo | undefined {
  // 1. Try exact qualified match
  const qualified = qualifiedMap.get(callee);
  if (qualified) return qualified;

  // 2. Try same-file qualified match: "sourceFile::callee"
  const sameFileQualified = qualifiedMap.get(`${sourceFile}::${callee}`);
  if (sameFileQualified) return sameFileQualified;

  // 3. Try simple name match (strip any prefix before the last dot)
  const simpleName = callee.includes('.') ? callee.split('.').pop()! : callee;

  // Prefer same-file match
  const sameFileCandidates = nameMap.get(simpleName)?.filter(
    (s) => s.file === sourceFile,
  );
  if (sameFileCandidates && sameFileCandidates.length > 0) {
    return sameFileCandidates[0];
  }

  // Fall back to any match
  const anyCandidates = nameMap.get(simpleName);
  if (anyCandidates && anyCandidates.length > 0) {
    return anyCandidates[0];
  }

  return undefined;
}
