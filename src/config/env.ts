/**
 * @module config/env
 * @description Strict environment-variable schema and fail-fast validator for the
 *   AI Code Review pipeline. Every configuration value the application needs is
 *   declared here so that misconfiguration is caught at startup — never at runtime.
 *
 *   The schema is built with **Zod** and parsed against `process.env` once. If any
 *   required variable is missing or any value fails coercion the process exits
 *   immediately (fail-fast), guaranteeing that downstream code can trust the
 *   shape of `env` completely.
 *
 *   ### Design principles
 *   - **No hardcoded model names** — all LLM model identifiers are aliases
 *     (`LLM_CHEAP_MODEL`, `LLM_BASE_MODEL`, `LLM_FRONTIER_MODEL`,
 *     `LLM_EMBEDDING_MODEL`) so swapping providers only requires an env change.
 *   - **Coercion over strict types** — `z.coerce.number()` and
 *     `z.coerce.boolean()` allow string env vars to be automatically converted.
 *   - **Sensible defaults** — optional fields carry production-reasonable defaults
 *     so a minimal `.env` is sufficient for local development.
 */

import { z } from 'zod';

// ---------------------------------------------------------------------------
// Zod schema
// ---------------------------------------------------------------------------

/**
 * The master environment schema. Every field corresponds to an environment
 * variable that the AI Code Review pipeline reads at startup.
 *
 * Sections:
 * 1. **LLM** — provider connection, model aliases, and per-tier token budgets
 * 2. **Pipeline** — execution guard-rails (max calls, cost cap, CoVe toggles)
 * 3. **Infrastructure** — external service URLs and credentials
 * 4. **MCP** — Model Context Protocol server settings
 * 5. **API** — HTTP listener configuration
 */
const EnvSchema = z.object({
  // ── LLM ──────────────────────────────────────────────────────────────────

  /** Base URL for the OpenAI-compatible LLM API (e.g. `https://api.openai.com/v1`). */
  LLM_BASE_URL: z.string().url(),

  /** API key used to authenticate against the LLM provider. */
  LLM_API_KEY: z.string().min(1),

  /**
   * Alias for the cheapest/fastest LLM model. Used for lightweight pipeline
   * steps such as landscape scanning and CoVe question generation.
   * No hardcoded model name — supply the model identifier via the environment.
   */
  LLM_CHEAP_MODEL: z.string().min(1),

  /**
   * Alias for the mid-tier LLM model. Used for risk mapping, consistency
   * reviews, and report generation.
   */
  LLM_BASE_MODEL: z.string().min(1),

  /**
   * Alias for the most capable (and expensive) LLM model. Reserved for
   * the core review logic, risk review, consensus, and CoVe verdict steps.
   */
  LLM_FRONTIER_MODEL: z.string().min(1),

  /**
   * Alias for the embedding model used to vectorise code and findings for
   * Qdrant similarity search.
   */
  LLM_EMBEDDING_MODEL: z.string().min(1),

  /** Maximum output tokens allowed for the cheap tier. @default 2048 */
  LLM_CHEAP_MAX_TOKENS: z.coerce.number().int().positive().default(2048),

  /** Maximum output tokens allowed for the base tier. @default 4096 */
  LLM_BASE_MAX_TOKENS: z.coerce.number().int().positive().default(4096),

  /** Maximum output tokens allowed for the frontier tier. @default 8192 */
  LLM_FRONTIER_MAX_TOKENS: z.coerce.number().int().positive().default(8192),

  /** Dimensionality of the embedding vectors. @default 1536 */
  LLM_EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),

  // ── Pipeline ─────────────────────────────────────────────────────────────

  /**
   * Hard cap on the total number of LLM calls a single pipeline run may make.
   * Acts as a safety-net against runaway recursion or prompt loops.
   * @default 25
   */
  PIPELINE_MAX_LLM_CALLS: z.coerce.number().int().positive().default(25),

  /**
   * Maximum estimated cost (in USD) for a single pipeline run. Exceeding this
   * budget causes the pipeline to abort early and report partial results.
   * @default 0.50
   */
  PIPELINE_MAX_COST_USD: z.coerce.number().positive().default(0.50),

  /**
   * Whether the Chain-of-Verification (CoVe) stage is enabled. When `false`,
   * the pipeline skips question generation, verification, and verdict steps.
   * @default true
   */
  PIPELINE_COVE_ENABLED: z.coerce.boolean().default(true),

  /**
   * Maximum number of findings the CoVe verifier will attempt to validate per
   * pipeline run. Limits cost and latency of the verification stage.
   * @default 5
   */
  PIPELINE_COVE_MAX_FINDINGS: z.coerce.number().int().positive().default(5),

  // ── Infrastructure ───────────────────────────────────────────────────────

  /** URL of the Qdrant vector database instance. */
  QDRANT_URL: z.string().url(),

  /** Bolt URL of the Neo4j graph database instance. */
  NEO4J_URL: z.string().min(1),

  /** Username for Neo4j authentication. */
  NEO4J_USER: z.string().min(1),

  /** Password for Neo4j authentication. */
  NEO4J_PASSWORD: z.string().min(1),

  /** Base URL of the self-hosted GitLab instance. */
  GITLAB_URL: z.string().url(),

  /** Personal access token for GitLab API authentication. */
  GITLAB_TOKEN: z.string().min(1),

  /** Secret token for validating GitLab webhook requests. */
  GITLAB_WEBHOOK_SECRET: z.string().min(1),

  /** URL of the Temporal server (e.g. `localhost:7233`). */
  TEMPORAL_URL: z.string().min(1),

  /** Temporal namespace for the worker. @default 'default' */
  TEMPORAL_NAMESPACE: z.string().min(1).default('default'),

  /** PostgreSQL connection string used by Prisma / the application database. */
  DATABASE_URL: z.string().min(1),

  /** JSON string mapping pipeline steps to model tiers. @default '{"landscapeScan":"cheap","riskMap":"base","reviewLogic":"frontier","reviewRisk":"frontier","reviewConsistency":"base","consensus":"frontier","coveQuestionGen":"cheap","coveVerifier":"base","coveVerdict":"frontier","report":"base"}' */
  PIPELINE_MODEL_MAP: z.string().min(1).default('{"landscapeScan":"cheap","riskMap":"base","reviewLogic":"frontier","reviewRisk":"frontier","reviewConsistency":"base","consensus":"frontier","coveQuestionGen":"cheap","coveVerifier":"base","coveVerdict":"frontier","report":"base"}'),

  // ── MCP ──────────────────────────────────────────────────────────────────

  /**
   * TCP port on which the MCP (Model Context Protocol) server listens.
   * @default 3001
   */
  MCP_PORT: z.coerce.number().int().positive().default(3001),

  /**
   * Transport protocol the MCP server should use.
   * - `stdio` — communicate over stdin/stdout (ideal for CLI integration)
   * - `sse`   — Server-Sent Events over HTTP (ideal for remote / browser clients)
   * @default 'stdio'
   */
  MCP_TRANSPORT: z.enum(['stdio', 'sse']).default('stdio'),

  // ── API ──────────────────────────────────────────────────────────────────

  /**
   * TCP port on which the Express HTTP API listens for webhook events and
   * REST queries.
   * @default 3000
   */
  API_PORT: z.coerce.number().int().positive().default(3000),

  /**
   * Language for the review report output.
   * @default 'en'
   */
  REVIEW_LANGUAGE: z.enum(['en', 'ru']).default('en'),
});

// ---------------------------------------------------------------------------
// Parsing & fail-fast
// ---------------------------------------------------------------------------

/**
 * Parsed and validated environment configuration.
 *
 * This is the **single source of truth** for every runtime config value. It is
 * computed once at module load time; if validation fails the process is
 * terminated with a non-zero exit code and a human-readable error report.
 */
export const env: Readonly<z.infer<typeof EnvSchema>> = EnvSchema.parse(
  process.env,
);

/**
 * Explicit startup validation hook.
 *
 * Call `validateEnv()` at the top of your entry-point (e.g. `main.ts`) to
 * trigger fail-fast validation before any other module imports execute. The
 * function returns the validated env object on success or terminates the
 * process on failure.
 *
 * @example
 * ```ts
 * import { validateEnv } from './config/env.js';
 *
 * const env = validateEnv(); // crashes if .env is misconfigured
 * console.log(`LLM base model: ${env.LLM_BASE_MODEL}`);
 * ```
 *
 * @returns The fully validated, read-only environment object.
 * @throws {never} Terminates the process with exit code 1 on validation failure.
 */
export function validateEnv(): Readonly<z.infer<typeof EnvSchema>> {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const formatted = Object.entries(errors)
      .map(([key, messages]) => `  • ${key}: ${messages?.join(', ')}`)
      .join('\n');

    console.error(
      '\n❌ Environment validation failed. The following variables are missing or invalid:\n' +
        formatted +
        '\n\nPlease check your .env file or container environment.\n',
    );
    process.exit(1);
  }

  return result.data;
}
