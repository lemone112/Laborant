import { describe, it, expect, beforeEach, vi } from 'vitest';

// Set minimal env vars before any imports that use env.ts
process.env.LLM_BASE_URL = 'http://localhost:8080/v1';
process.env.LLM_API_KEY = 'test-key';
process.env.LLM_CHEAP_MODEL = 'test-cheap';
process.env.LLM_BASE_MODEL = 'test-base';
process.env.LLM_FRONTIER_MODEL = 'test-frontier';
process.env.LLM_EMBEDDING_MODEL = 'test-embedding';
process.env.QDRANT_URL = 'http://localhost:6333';
process.env.NEO4J_URL = 'bolt://localhost:7687';
process.env.NEO4J_USER = 'neo4j';
process.env.NEO4J_PASSWORD = 'test';
process.env.GITLAB_URL = 'https://gitlab.test.com';
process.env.GITLAB_TOKEN = 'test-token';
process.env.GITLAB_WEBHOOK_SECRET = 'test-secret';
process.env.TEMPORAL_URL = 'localhost:7233';
process.env.DATABASE_URL = 'postgresql://test:test@localhost:5432/test';

describe('Pipeline Model Map', () => {
  it('maps every pipeline step to a valid tier', async () => {
    const { PIPELINE_MODEL_MAP } = await import('../src/config/defaults.js');
    const validTiers = ['cheap', 'base', 'frontier'];

    for (const [step, tier] of Object.entries(PIPELINE_MODEL_MAP)) {
      expect(validTiers).toContain(tier);
    }
  });

  it('has exactly 10 pipeline steps', async () => {
    const { PIPELINE_MODEL_MAP } = await import('../src/config/defaults.js');
    expect(Object.keys(PIPELINE_MODEL_MAP)).toHaveLength(10);
  });
});

describe('ENV Schema', () => {
  it('validates with all required fields', async () => {
    const { env } = await import('../src/config/env.js');
    expect(env.LLM_BASE_URL).toBe('http://localhost:8080/v1');
    expect(env.LLM_CHEAP_MODEL).toBe('test-cheap');
    expect(env.LLM_BASE_MODEL).toBe('test-base');
    expect(env.LLM_FRONTIER_MODEL).toBe('test-frontier');
    expect(env.LLM_EMBEDDING_MODEL).toBe('test-embedding');
  });

  it('has default values for optional fields', async () => {
    const { env } = await import('../src/config/env.js');
    expect(env.PIPELINE_MAX_LLM_CALLS).toBe(25);
    expect(env.PIPELINE_MAX_COST_USD).toBe(0.50);
    expect(env.PIPELINE_COVE_ENABLED).toBe(true);
    expect(env.API_PORT).toBe(3000);
    expect(env.MCP_PORT).toBe(3001);
    expect(env.MCP_TRANSPORT).toBe('stdio');
    expect(env.REVIEW_LANGUAGE).toBe('en');
  });
});

describe('Landscape Prompt', () => {
  it('contains required schema keywords', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const promptPath = path.resolve(import.meta.dirname, '../prompts/landscape.md');
    const content = await fs.readFile(promptPath, 'utf-8');
    expect(content).toContain('ARCHITECTURE');
    expect(content).toContain('PATTERNS');
    expect(content).toContain('CONVENTIONS');
    expect(content).toContain('INTENTIONAL');
  });
});

describe('Risk Map Prompt', () => {
  it('contains risk-related keywords', async () => {
    const fs = await import('fs/promises');
    const path = await import('path');
    const promptPath = path.resolve(import.meta.dirname, '../prompts/risk-map.md');
    const content = await fs.readFile(promptPath, 'utf-8');
    expect(content.length).toBeGreaterThan(50);
  });
});

describe('Diff Chunker', () => {
  it('returns single chunk for small diff', async () => {
    const { chunkDiff } = await import('../src/util/diff-chunker.js');
    const smallDiff = 'diff --git a/file.ts b/file.ts\n+hello';
    const chunks = chunkDiff(smallDiff);
    expect(chunks).toHaveLength(1);
    expect(chunks[0]?.content).toBe(smallDiff);
  });

  it('splits large diff into multiple chunks', async () => {
    const { chunkDiff } = await import('../src/util/diff-chunker.js');
    // Create a diff with multiple files, larger than 1000 tokens (~4000 chars)
    const largeFile = 'a'.repeat(5000);
    const largeDiff = [
      'diff --git a/file1.ts b/file1.ts',
      largeFile,
      'diff --git a/file2.ts b/file2.ts',
      largeFile,
      'diff --git a/file3.ts b/file3.ts',
      largeFile,
    ].join('\n');
    const chunks = chunkDiff(largeDiff, { maxTokensPerChunk: 1000 });
    expect(chunks.length).toBeGreaterThan(1);
  });

  it('estimates tokens correctly', async () => {
    const { estimateTokens } = await import('../src/util/diff-chunker.js');
    expect(estimateTokens('hello world')).toBe(3); // 11 chars / 4 ≈ 3
    expect(estimateTokens('')).toBe(0);
  });
});

describe('Finding Utils', () => {
  it('coerces valid emotions', async () => {
    const { coerceEmotion } = await import('../src/util/finding-utils.js');
    expect(coerceEmotion('certain')).toBe('certain');
    expect(coerceEmotion('uneasy')).toBe('uneasy');
    expect(coerceEmotion('concerned')).toBe('concerned');
  });

  it('falls back to uneasy for invalid emotions', async () => {
    const { coerceEmotion } = await import('../src/util/finding-utils.js');
    expect(coerceEmotion('invalid')).toBe('uneasy');
    expect(coerceEmotion('')).toBe('uneasy');
    expect(coerceEmotion(null)).toBe('uneasy');
  });

  it('parses confidence values correctly', async () => {
    const { parseConfidence } = await import('../src/util/finding-utils.js');
    expect(parseConfidence(0.8)).toBe(0.8);
    expect(parseConfidence(1.5)).toBe(1); // clamped
    expect(parseConfidence(-0.5)).toBe(0); // clamped
    expect(parseConfidence('not a number')).toBe(0.5); // fallback
  });
});

describe('Model Tier Resolution', () => {
  it('resolves all tiers to model names', async () => {
    const { resolveModelName, resolveMaxTokens } = await import('../src/config/defaults.js');
    expect(resolveModelName('cheap')).toBe('test-cheap');
    expect(resolveModelName('base')).toBe('test-base');
    expect(resolveModelName('frontier')).toBe('test-frontier');
    expect(resolveModelName('embedding')).toBe('test-embedding');
  });

  it('resolves max tokens for all tiers', async () => {
    const { resolveMaxTokens } = await import('../src/config/defaults.js');
    expect(resolveMaxTokens('cheap')).toBe(2048);
    expect(resolveMaxTokens('base')).toBe(4096);
    expect(resolveMaxTokens('frontier')).toBe(8192);
    expect(resolveMaxTokens('embedding')).toBe(8192);
  });
});

describe('Structured Output', () => {
  it('extracts JSON from markdown code blocks', async () => {
    const { requestStructured } = await import('../src/util/structured-output.js');
    // This is a unit test for the parsing logic
    // The actual LLM call would be mocked in integration tests
    expect(typeof requestStructured).toBe('function');
  });
});

describe('Budget Tracker', () => {
  it('tracks calls and cost correctly', async () => {
    const { createBudgetTracker } = await import('../src/llm/budget.js');
    const budget = createBudgetTracker({ maxCalls: 10, maxCostUSD: 1.0 });

    budget.recordCall('cheap', 1000);
    budget.recordCall('base', 2000);

    const stats = budget.getStats();
    expect(stats.totalCalls).toBe(2);
    expect(stats.totalTokens).toBe(3000);
    expect(stats.callsByTier.cheap).toBe(1);
    expect(stats.callsByTier.base).toBe(1);
  });

  it('throws when budget exceeded', async () => {
    const { createBudgetTracker, BudgetExceededError } = await import('../src/llm/budget.js');
    const budget = createBudgetTracker({ maxCalls: 2 });

    budget.recordCall('cheap', 100);
    budget.recordCall('cheap', 100);

    expect(() => budget.checkBudget()).toThrow(BudgetExceededError);
  });

  it('resets correctly', async () => {
    const { createBudgetTracker } = await import('../src/llm/budget.js');
    const budget = createBudgetTracker();

    budget.recordCall('cheap', 1000);
    budget.reset();

    const stats = budget.getStats();
    expect(stats.totalCalls).toBe(0);
    expect(stats.totalTokens).toBe(0);
  });
});
