/**
 * @module config/env
 * @description Environment-variable schema with Zod.
 *
 * Only LLM_* vars are required. All infrastructure (Neo4j, Qdrant, PG)
 * is optional — the pipeline degrades gracefully when unavailable.
 */

import { z } from 'zod';

const EnvSchema = z.object({
  // ── LLM (required) ────────────────────────────────────────────────────────

  LLM_BASE_URL: z.string().url(),
  LLM_API_KEY: z.string().min(1),
  LLM_CHEAP_MODEL: z.string().min(1),
  LLM_BASE_MODEL: z.string().min(1),
  LLM_FRONTIER_MODEL: z.string().min(1),
  LLM_EMBEDDING_MODEL: z.string().min(1),

  LLM_CHEAP_MAX_TOKENS: z.coerce.number().int().positive().default(2048),
  LLM_BASE_MAX_TOKENS: z.coerce.number().int().positive().default(4096),
  LLM_FRONTIER_MAX_TOKENS: z.coerce.number().int().positive().default(8192),
  LLM_EMBEDDING_DIM: z.coerce.number().int().positive().default(1536),

  // ── Pipeline ──────────────────────────────────────────────────────────────

  PIPELINE_MAX_LLM_CALLS: z.coerce.number().int().positive().default(25),
  PIPELINE_MAX_COST_USD: z.coerce.number().positive().default(0.50),
  PIPELINE_COVE_ENABLED: z.coerce.boolean().default(true),
  PIPELINE_COVE_MAX_FINDINGS: z.coerce.number().int().positive().default(5),
  PIPELINE_TRIPLE_REVIEW: z.coerce.boolean().default(true),

  PIPELINE_MODEL_MAP: z.string().min(1).default(
    '{"landscapeScan":"cheap","riskMap":"base","reviewLogic":"frontier","reviewRisk":"frontier","reviewConsistency":"base","consensus":"frontier","coveVerify":"base","report":"base"}',
  ),

  // ── Infrastructure (optional — pipeline works without them) ────────────────

  NEO4J_URL: z.string().min(1).optional().default('bolt://localhost:7687'),
  NEO4J_USER: z.string().min(1).optional().default('neo4j'),
  NEO4J_PASSWORD: z.string().min(1).optional().default(''),

  QDRANT_URL: z.string().min(1).optional().default('http://localhost:6333'),

  DATABASE_URL: z.string().min(1).optional().default('postgresql://localhost:5432/laborant'),

  // ── GitLab ────────────────────────────────────────────────────────────────

  GITLAB_URL: z.string().url().optional().default('https://gitlab.com'),
  GITLAB_TOKEN: z.string().min(1).optional().default(''),
  GITLAB_WEBHOOK_SECRET: z.string().min(1).optional().default(''),

  // ── Temporal ──────────────────────────────────────────────────────────────

  TEMPORAL_URL: z.string().min(1).optional().default('localhost:7233'),
  TEMPORAL_NAMESPACE: z.string().min(1).default('default'),

  // ── MCP ───────────────────────────────────────────────────────────────────

  MCP_PORT: z.coerce.number().int().positive().default(3001),
  MCP_TRANSPORT: z.enum(['stdio', 'sse']).default('stdio'),

  // ── API ───────────────────────────────────────────────────────────────────

  API_PORT: z.coerce.number().int().positive().default(3000),
  REVIEW_LANGUAGE: z.enum(['en', 'ru']).default('en'),
});

export type Env = Readonly<z.infer<typeof EnvSchema>>;

export function validateEnv(): Env {
  const result = EnvSchema.safeParse(process.env);

  if (!result.success) {
    const errors = result.error.flatten().fieldErrors;
    const formatted = Object.entries(errors)
      .map(([key, messages]) => `  • ${key}: ${messages?.join(', ')}`)
      .join('\n');

    console.error(
      '\n❌ Environment validation failed:\n' + formatted + '\n',
    );
    process.exit(1);
  }

  return result.data;
}

/** Validated env — computed once at module load. */
export const env: Env = validateEnv();
