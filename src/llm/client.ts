/**
 * @module llm/client
 * @description OpenAI SDK wrapper with tier-based routing, budget tracking,
 * automatic retries, and structured logging.
 *
 * ### Architecture
 *
 * ```
 * ┌──────────────┐     ┌──────────────┐     ┌──────────────┐
 * │  client.ts   │────▶│   tiers.ts   │────▶│   env.ts     │
 * │  (this file) │     │  (model cfg) │     │ (secrets)    │
 * └──────┬───────┘     └──────────────┘     └──────────────┘
 *        │
 *        ▼
 * ┌──────────────┐
 * │  budget.ts   │  ← call counting & cost guard
 * └──────────────┘
 * ```
 *
 * ### Usage
 *
 * ```ts
 * const llm = new LLMClient();
 *
 * // Chat completion
 * const reply = await llm.chat('base', [
 *   { role: 'system', content: 'You are a code reviewer.' },
 *   { role: 'user',   content: 'Review this diff…' },
 * ]);
 *
 * // Convenience: system + user in one call
 * const result = await llm.complete('cheap', 'Classify bugs', '…diff…');
 *
 * // Embedding
 * const vectors = await llm.embed(['hello', 'world']);
 * ```
 */

import OpenAI from 'openai';
import type { ChatCompletionMessageParam } from 'openai/resources/chat/completions.js';
import type { EmbeddingCreateParams } from 'openai/resources/embeddings.js';

import { env } from '../config/env.js';
import { getTierConfig } from './tiers.js';
import type { ModelTier } from './tiers.js';
import { BudgetTracker, createBudgetTracker } from './budget.js';

// ── Types ────────────────────────────────────────────────────────────

/**
 * Options that can be passed to the {@link LLMClient.chat} method.
 */
export interface ChatOptions {
  /**
   * Request JSON-mode output from the model.
   * When `true`, sends `response_format: { type: 'json_object' }`.
   * @default false
   */
  jsonMode?: boolean;

  /**
   * Override the `max_tokens` value from the tier config.
   * Useful when a specific call needs fewer tokens than the tier default.
   */
  maxTokens?: number;

  /**
   * Sampling temperature (0–2).  Lower values produce more deterministic
   * output.  When omitted the API default is used.
   */
  temperature?: number;
}

/**
 * Parsed result returned from {@link LLMClient.chat} and
 * {@link LLMClient.complete}.
 */
export interface ChatResult {
  /** The model that generated the response. */
  model: string;

  /** The text content of the assistant's reply. */
  content: string;

  /**
   * Parsed JSON object when `jsonMode` was requested **and** the response
   * contains valid JSON.  `null` otherwise.
   */
  parsed: Record<string, unknown> | null;

  /** Total tokens consumed (prompt + completion). */
  totalTokens: number;
}

/**
 * Result returned from {@link LLMClient.embed}.
 */
export interface EmbedResult {
  /** The model used for embedding. */
  model: string;

  /** Embedding vectors, one per input string. */
  embeddings: number[][];

  /** Total tokens consumed across all inputs. */
  totalTokens: number;
}

// ── Logging helper ───────────────────────────────────────────────────

/**
 * Lightweight structured logger.  Swap with Pino / Winston in production.
 *
 * @param level  - Log severity.
 * @param tier   - The model tier that triggered the log.
 * @param model  - The concrete model identifier.
 * @param tokens - Tokens consumed (0 when logging before the call).
 * @param extra  - Arbitrary extra fields.
 */
function log(
  level: 'info' | 'warn' | 'error',
  tier: ModelTier,
  model: string,
  tokens: number,
  extra?: Record<string, unknown>,
): void {
  const timestamp = new Date().toISOString();
  const base = { timestamp, level, tier, model, tokens };
  const payload = extra ? { ...base, ...extra } : base;
  const prefix = level === 'error' ? '❌' : level === 'warn' ? '⚠️' : '✅';
  // eslint-disable-next-line no-console
  console.log(`${prefix} [LLM] ${JSON.stringify(payload)}`);
}

// ── Retry helper ─────────────────────────────────────────────────────

/** Maximum number of retry attempts for transient errors. */
const MAX_RETRIES = 3;

/** Base delay in milliseconds for exponential backoff. */
const BASE_DELAY_MS = 1_000;

/**
 * Determine whether an error is retryable (rate-limit, server error, network).
 *
 * @param error - The thrown value.
 * @returns `true` if the caller should retry.
 */
function isRetryable(error: unknown): boolean {
  if (error instanceof OpenAI.APIError) {
    const status = error.status ?? 0;
    // 429 = rate limit, 5xx = server error
    return status === 429 || (status >= 500 && status < 600);
  }
  // Network-level errors (ECONNRESET, ETIMEDOUT, etc.)
  if (error instanceof Error && 'code' in error) {
    const code = (error as NodeJS.ErrnoException).code;
    return typeof code === 'string' && ['ECONNRESET', 'ETIMEDOUT', 'ENOTFOUND', 'EAI_AGAIN'].includes(code);
  }
  return false;
}

/**
 * Sleep for the specified number of milliseconds.
 *
 * @param ms - Duration to sleep.
 */
function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

// ── Interface (DIP: depend on abstractions, not concretions) ─────────

/**
 * Abstraction for LLM client operations.
 *
 * All consumers should depend on this interface rather than the concrete
 * {@link LLMClient} class. This enables:
 * - Easy mocking in tests (no need to mock OpenAI SDK)
 * - Swapping LLM providers without changing consumer code
 * - Clean Architecture compliance (domain → interface, not domain → infra)
 */
export interface ILLMClient {
  /**
   * Send a chat completion request using the specified model tier.
   */
  chat(
    tier: ModelTier,
    messages: ChatCompletionMessageParam[],
    options?: ChatOptions,
  ): Promise<ChatResult>;

  /**
   * Convenience wrapper: system + user in one call.
   */
  complete(
    tier: ModelTier,
    system: string,
    user: string,
    options?: ChatOptions,
  ): Promise<ChatResult>;

  /**
   * Generate embeddings for a list of text strings.
   */
  embed(texts: string[]): Promise<EmbedResult>;
}

// ── LLMClient ────────────────────────────────────────────────────────

/**
 * High-level LLM client with tier-based routing, budget enforcement,
 * automatic retries, and structured logging.
 *
 * ### Lifecycle
 *
 * 1. Instantiate once (module-level singleton is fine).
 * 2. Call {@link chat}, {@link complete}, or {@link embed} as needed.
 * 3. Each call automatically checks the budget, selects the model from
 *    the tier config, and records usage.
 *
 * ### Error Handling
 *
 * Transient errors (HTTP 429, 5xx, network timeouts) are retried up to
 * 3 times with exponential backoff (1 s → 2 s → 4 s).  Non-retryable
 * errors and all errors after the final retry propagate to the caller.
 */
export class LLMClient implements ILLMClient {
  /** The underlying OpenAI SDK instance. */
  private readonly openai: OpenAI;

  /** Budget tracker used for this client instance. */
  private readonly budget: BudgetTracker;

  /**
   * Create a new LLM client.
   *
   * @param options           - Constructor options.
   * @param options.budget    - A {@link BudgetTracker} instance
   *   (defaults to the module-level singleton).
   */
  constructor(options?: { budget?: BudgetTracker }) {
    this.openai = new OpenAI({
      baseURL: env.LLM_BASE_URL,
      apiKey: env.LLM_API_KEY,
    });
    this.budget = options?.budget ?? createBudgetTracker();
  }

  // ── Chat ──────────────────────────────────────────────────────────

  /**
   * Send a chat completion request using the specified model tier.
   *
   * Automatically enforces budget limits, selects the model from tier
   * config, and retries on transient errors.
   *
   * @param tier     - The model tier to use.
   * @param messages - Conversation messages to send.
   * @param options  - Optional overrides (JSON mode, max tokens, temperature).
   * @returns A {@link ChatResult} with the assistant's reply.
   * @throws {BudgetExceededError} If the budget limit has been reached.
   * @throws {OpenAI.APIError}     If the API returns a non-retryable error.
   * @throws {Error}               If all retries are exhausted.
   *
   * @example
   * ```ts
   * const result = await llm.chat('base', [
   *   { role: 'system', content: 'You are a code reviewer.' },
   *   { role: 'user',   content: 'Review this diff…' },
   * ], { jsonMode: true });
   *
   * console.log(result.parsed); // { findings: […] }
   * ```
   */
  async chat(
    tier: ModelTier,
    messages: ChatCompletionMessageParam[],
    options?: ChatOptions,
  ): Promise<ChatResult> {
    const config = getTierConfig(tier);
    this.budget.checkBudget();

    const maxTokens = options?.maxTokens ?? config.maxTokens;

    const requestParams: OpenAI.Chat.Completions.ChatCompletionCreateParams = {
      model: config.model,
      messages,
      max_tokens: maxTokens,
      ...(options?.temperature !== undefined && { temperature: options.temperature }),
      ...(options?.jsonMode && { response_format: { type: 'json_object' } }),
    };

    log('info', tier, config.model, 0, { event: 'request', maxTokens, jsonMode: options?.jsonMode ?? false });

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.openai.chat.completions.create(requestParams);

        const choice = response.choices[0];
        const content = choice?.message?.content ?? '';
        const totalTokens = response.usage?.total_tokens ?? 0;

        // Track budget
        this.budget.recordCall(tier, totalTokens);

        // Attempt JSON parse when jsonMode was requested
        let parsed: Record<string, unknown> | null = null;
        if (options?.jsonMode && content) {
          try {
            parsed = JSON.parse(content) as Record<string, unknown>;
          } catch {
            log('warn', tier, config.model, totalTokens, {
              event: 'json_parse_failed',
              attempt,
            });
          }
        }

        log('info', tier, config.model, totalTokens, {
          event: 'response',
          finishReason: choice?.finish_reason,
          attempt,
        });

        return {
          model: response.model,
          content,
          parsed,
          totalTokens,
        };
      } catch (error: unknown) {
        lastError = error;

        if (!isRetryable(error) || attempt === MAX_RETRIES) {
          log('error', tier, config.model, 0, {
            event: 'fatal_error',
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        const delayMs = BASE_DELAY_MS * 2 ** (attempt - 1);
        log('warn', tier, config.model, 0, {
          event: 'retry',
          attempt,
          nextDelayMs: delayMs,
          error: error instanceof Error ? error.message : String(error),
        });

        await sleep(delayMs);
      }
    }

    // Should be unreachable, but TypeScript needs it for type safety.
    throw lastError;
  }

  // ── Complete (convenience) ────────────────────────────────────────

  /**
   * Convenience wrapper around {@link chat} that accepts `system` and
   * `user` strings instead of a full message array.
   *
   * @param tier    - The model tier to use.
   * @param system  - The system prompt.
   * @param user    - The user message.
   * @param options - Optional overrides (same as {@link ChatOptions}).
   * @returns A {@link ChatResult} with the assistant's reply.
   *
   * @example
   * ```ts
   * const result = await llm.complete(
   *   'cheap',
   *   'Classify the severity of each bug.',
   *   'Line 42: null pointer dereference',
   *   { jsonMode: true },
   * );
   * ```
   */
  async complete(
    tier: ModelTier,
    system: string,
    user: string,
    options?: ChatOptions,
  ): Promise<ChatResult> {
    const messages: ChatCompletionMessageParam[] = [
      { role: 'system', content: system },
      { role: 'user', content: user },
    ];
    return this.chat(tier, messages, options);
  }

  // ── Embed ─────────────────────────────────────────────────────────

  /**
   * Generate embeddings for a list of text strings using the
   * `embedding` tier model.
   *
   * @param texts - Input strings to embed.
   * @returns An {@link EmbedResult} with one vector per input string.
   * @throws {BudgetExceededError} If the budget limit has been reached.
   * @throws {OpenAI.APIError}     If the API returns a non-retryable error.
   * @throws {Error}               If all retries are exhausted.
   *
   * @example
   * ```ts
   * const { embeddings, totalTokens } = await llm.embed([
   *   'function add(a, b) { return a + b; }',
   *   'class Foo { bar() {} }',
   * ]);
   * // embeddings[0].length === 1536 (or env.LLM_EMBEDDING_DIM)
   * ```
   */
  async embed(texts: string[]): Promise<EmbedResult> {
    const config = getTierConfig('embedding');
    this.budget.checkBudget();

    const requestParams: EmbeddingCreateParams = {
      model: config.model,
      input: texts,
    };

    log('info', 'embedding', config.model, 0, {
      event: 'embed_request',
      inputCount: texts.length,
    });

    let lastError: unknown;

    for (let attempt = 1; attempt <= MAX_RETRIES; attempt++) {
      try {
        const response = await this.openai.embeddings.create(requestParams);

        const totalTokens = response.usage?.total_tokens ?? 0;
        this.budget.recordCall('embedding', totalTokens);

        const embeddings = response.data
          .sort((a, b) => a.index - b.index)
          .map((item) => item.embedding);

        log('info', 'embedding', config.model, totalTokens, {
          event: 'embed_response',
          vectorCount: embeddings.length,
          attempt,
        });

        return {
          model: response.model,
          embeddings,
          totalTokens,
        };
      } catch (error: unknown) {
        lastError = error;

        if (!isRetryable(error) || attempt === MAX_RETRIES) {
          log('error', 'embedding', config.model, 0, {
            event: 'embed_fatal_error',
            attempt,
            error: error instanceof Error ? error.message : String(error),
          });
          throw error;
        }

        const delayMs = BASE_DELAY_MS * 2 ** (attempt - 1);
        log('warn', 'embedding', config.model, 0, {
          event: 'embed_retry',
          attempt,
          nextDelayMs: delayMs,
          error: error instanceof Error ? error.message : String(error),
        });

        await sleep(delayMs);
      }
    }

    // Should be unreachable, but TypeScript needs it for type safety.
    throw lastError;
  }
}

/**
 * Create a new LLMClient with a fresh budget tracker for a single pipeline run.
 * Each review MUST use its own client to avoid budget conflicts.
 */
export function createLLMClient(budget: BudgetTracker): LLMClient {
  return new LLMClient({ budget });
}
