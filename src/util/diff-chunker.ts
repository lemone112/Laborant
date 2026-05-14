/**
 * @module util/diff-chunker
 * @description Splits large diffs into token-aware chunks for LLM processing.
 *
 * Problem: A merge request with 3000+ lines of diff will exceed most LLM context
 * windows (e.g. 128K tokens → ~80K effective after system prompt + output tokens).
 *
 * Solution: Split the diff into file-level or section-level chunks that fit within
 * a configurable token budget. Each chunk preserves file context headers so the LLM
 * knows which file it's reviewing.
 *
 * Token estimation: ~4 characters per token for code (conservative estimate).
 */

/** Approximate characters per token for source code */
const CHARS_PER_TOKEN = 4;

export interface DiffChunk {
  /** The chunk content (diff with file headers) */
  content: string;
  /** Estimated token count */
  estimatedTokens: number;
  /** File paths included in this chunk */
  files: string[];
}

export interface ChunkOptions {
  /** Maximum tokens per chunk (default: 6000, leaving room for system prompt + output) */
  maxTokensPerChunk: number;
  /** Whether to keep file-level boundaries (default: true) */
  preserveFileBoundaries: boolean;
}

const DEFAULT_OPTIONS: ChunkOptions = {
  maxTokensPerChunk: 6000,
  preserveFileBoundaries: true,
};

/**
 * Estimate token count for a text string.
 * Uses conservative 4 chars/token estimate for code.
 */
export function estimateTokens(text: string): number {
  return Math.ceil(text.length / CHARS_PER_TOKEN);
}

/**
 * Split a unified diff into file-level sections.
 * Each section starts with a `diff --git` or `--- a/` / `+++ b/` header.
 */
export function splitDiffByFile(diff: string): Map<string, string> {
  const files = new Map<string, string>();
  const lines = diff.split('\n');
  let currentFile = '';
  let currentContent: string[] = [];

  for (const line of lines) {
    // Detect file boundaries
    const diffHeader = line.match(/^diff --git a\/(.+?) b\/(.+)$/);
    const newFileHeader = line.match(/^\+\+\+ b\/(.+)$/);

    if (diffHeader) {
      // Save previous file
      if (currentFile && currentContent.length > 0) {
        files.set(currentFile, currentContent.join('\n'));
      }
      currentFile = diffHeader[2] ?? diffHeader[1] ?? 'unknown';
      currentContent = [line];
    } else if (newFileHeader && !diffHeader) {
      // Sometimes +++ b/file appears without diff --git
      if (currentFile && currentContent.length > 0) {
        files.set(currentFile, currentContent.join('\n'));
      }
      currentFile = newFileHeader[1] ?? 'unknown';
      currentContent = [line];
    } else {
      currentContent.push(line);
    }
  }

  // Save last file
  if (currentFile && currentContent.length > 0) {
    files.set(currentFile, currentContent.join('\n'));
  }

  return files;
}

/**
 * Split a large diff into chunks that fit within a token budget.
 *
 * Strategy:
 * 1. Split diff by file boundaries
 * 2. Greedily pack files into chunks until token budget is reached
 * 3. If a single file exceeds the budget, split it by hunk (@@ markers)
 * 4. Each chunk includes a header listing all files in the chunk
 *
 * @param diff - The raw unified diff
 * @param options - Chunking options
 * @returns Array of DiffChunk objects
 */
export function chunkDiff(
  diff: string,
  options: Partial<ChunkOptions> = {},
): DiffChunk[] {
  const opts = { ...DEFAULT_OPTIONS, ...options };
  const maxChars = opts.maxTokensPerChunk * CHARS_PER_TOKEN;

  // If diff fits in a single chunk, return it as-is
  if (diff.length <= maxChars) {
    return [{
      content: diff,
      estimatedTokens: estimateTokens(diff),
      files: extractFileList(diff),
    }];
  }

  // Split by file
  const fileSections = splitDiffByFile(diff);
  const chunks: DiffChunk[] = [];
  let currentChunk: string[] = [];
  let currentFiles: string[] = [];
  let currentSize = 0;

  const flushChunk = () => {
    if (currentChunk.length > 0) {
      const content = currentChunk.join('\n');
      chunks.push({
        content,
        estimatedTokens: estimateTokens(content),
        files: [...currentFiles],
      });
      currentChunk = [];
      currentFiles = [];
      currentSize = 0;
    }
  };

  for (const [file, section] of fileSections) {
    const sectionSize = section.length;

    if (sectionSize > maxChars) {
      // File too large — split by hunk
      flushChunk();
      const hunks = splitByHunk(section);
      for (const hunk of hunks) {
        if (hunk.length > maxChars) {
          // Even a single hunk is too large — truncate with marker
          flushChunk();
          const truncated = hunk.slice(0, maxChars - 100) + '\n... [TRUNCATED - diff too large] ...\n';
          chunks.push({
            content: truncated,
            estimatedTokens: opts.maxTokensPerChunk,
            files: [file],
          });
        } else if (currentSize + hunk.length > maxChars) {
          flushChunk();
          currentChunk.push(hunk);
          currentFiles.push(file);
          currentSize = hunk.length;
        } else {
          currentChunk.push(hunk);
          if (!currentFiles.includes(file)) currentFiles.push(file);
          currentSize += hunk.length;
        }
      }
    } else if (currentSize + sectionSize > maxChars) {
      flushChunk();
      currentChunk.push(section);
      currentFiles.push(file);
      currentSize = sectionSize;
    } else {
      currentChunk.push(section);
      if (!currentFiles.includes(file)) currentFiles.push(file);
      currentSize += sectionSize;
    }
  }

  flushChunk();
  return chunks;
}

/**
 * Split a file's diff into hunks (sections between @@ markers).
 */
function splitByHunk(fileDiff: string): string[] {
  const hunks: string[] = [];
  const lines = fileDiff.split('\n');
  let currentHunk: string[] = [];
  let hasHeader = true;

  for (const line of lines) {
    if (line.startsWith('@@') && !hasHeader) {
      if (currentHunk.length > 0) {
        hunks.push(currentHunk.join('\n'));
      }
      currentHunk = [line];
    } else {
      currentHunk.push(line);
      hasHeader = false;
    }
  }

  if (currentHunk.length > 0) {
    hunks.push(currentHunk.join('\n'));
  }

  return hunks.length > 0 ? hunks : [fileDiff];
}

/**
 * Extract file list from a unified diff.
 */
function extractFileList(diff: string): string[] {
  const files = new Set<string>();
  for (const line of diff.split('\n')) {
    const match = line.match(/^diff --git a\/.+ b\/(.+)$/);
    if (match?.[1]) files.add(match[1]);
    const match2 = line.match(/^\+\+\+ b\/(.+)$/);
    if (match2?.[1]) files.add(match2[1]);
  }
  return [...files];
}

/**
 * Truncate text to a maximum token count, adding a truncation marker.
 */
export function truncateToTokens(text: string, maxTokens: number, marker = '\n... [truncated] ...\n'): string {
  const maxChars = maxTokens * CHARS_PER_TOKEN;
  if (text.length <= maxChars) return text;
  return text.slice(0, maxChars - marker.length) + marker;
}
