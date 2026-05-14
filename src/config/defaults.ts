/**
 * @module config/defaults
 * @description Pipeline defaults, model-to-tier mapping, domain enums, and
 *   TypeScript interfaces for every artifact produced by the AI Code Review
 *   pipeline.
 *
 *   ### Contents
 *   1. **PIPELINE_MODEL_MAP** — declares which LLM tier each pipeline step uses
 *      so the orchestrator can resolve model names, token limits, and cost
 *      budgets without hardcoding.
 *   2. **EMOTION** enum — the epistemic-emotional tags a reviewer LLM can assign
 *      to a finding, enabling downstream consumers to prioritise and escalate.
 *   3. **SEVERITY** enum — triage levels for inline review comments.
 *   4. **Artifact interfaces** — typed contracts for every intermediate and
 *      terminal artifact the pipeline produces (landscape, risk map, findings,
 *      consensus, CoVe verification, and the final report).
 *
 *   All types are **named exports** so consumers can cherry-pick without pulling
 *   in the entire module graph.
 */

import { env } from './env.js';
import type { ModelTier } from '../llm/tiers.js';

// Re-export ModelTier for convenience
export type { ModelTier };

// ────────────────────────────────────────────────────────────────────────────
// Model tier helpers
// ────────────────────────────────────────────────────────────────────────────

/**
 * The LLM capability tiers the pipeline distinguishes.
 *
 * - `cheap`    — fast, low-cost; used for bulk classification & generation
 * - `base`     — balanced quality/cost; used for structured analysis
 * - `frontier` — highest capability; reserved for judgement-heavy steps
 * - `embedding` — text → vector embedding
 */

/**
 * Resolves a {@link ModelTier} to the concrete model name configured via
 * environment variables. This is the single place where the mapping from
 * logical tier to physical model identifier happens.
 *
 * @param tier - The model tier to resolve.
 * @returns The model name string (e.g. `env.LLM_CHEAP_MODEL`).
 */
export function resolveModelName(tier: ModelTier): string {
  switch (tier) {
    case 'cheap': return env.LLM_CHEAP_MODEL;
    case 'base': return env.LLM_BASE_MODEL;
    case 'frontier': return env.LLM_FRONTIER_MODEL;
    case 'embedding': return env.LLM_EMBEDDING_MODEL;
  }
}

/**
 * Resolves a {@link ModelTier} to the maximum output-token budget configured
 * via environment variables.
 *
 * @param tier - The model tier to resolve.
 * @returns The token limit (e.g. `env.LLM_CHEAP_MAX_TOKENS`).
 */
export function resolveMaxTokens(tier: ModelTier): number {
  switch (tier) {
    case 'cheap': return env.LLM_CHEAP_MAX_TOKENS;
    case 'base': return env.LLM_BASE_MAX_TOKENS;
    case 'frontier': return env.LLM_FRONTIER_MAX_TOKENS;
    case 'embedding': return 8192;
  }
}

// ────────────────────────────────────────────────────────────────────────────
// Pipeline step → model tier mapping (from ENV)
// ────────────────────────────────────────────────────────────────────────────

/**
 * Canonical names for every step in the AI Code Review pipeline.
 *
 * These keys are used throughout the codebase to reference pipeline stages
 * without coupling to implementation details.
 */
export type PipelineStep =
  | 'landscapeScan'
  | 'riskMap'
  | 'reviewLogic'
  | 'reviewRisk'
  | 'reviewConsistency'
  | 'consensus'
  | 'coveVerify'
  | 'report';

/**
 * Parse and validate the PIPELINE_MODEL_MAP from environment.
 * 
 * The map is stored as a JSON string in the PIPELINE_MODEL_MAP env var.
 * Each key must be a valid PipelineStep, each value must be a valid ModelTier.
 */
function parseModelMap(): Readonly<Record<PipelineStep, ModelTier>> {
  const defaultMap: Record<PipelineStep, ModelTier> = {
    landscapeScan: 'cheap',
    riskMap: 'base',
    reviewLogic: 'frontier',
    reviewRisk: 'frontier',
    reviewConsistency: 'base',
    consensus: 'frontier',
    coveVerify: 'base',
    report: 'base',
  };

  try {
    const parsed = JSON.parse(env.PIPELINE_MODEL_MAP);
    
    // Validate keys and values
    const validSteps: PipelineStep[] = [
      'landscapeScan', 'riskMap', 'reviewLogic', 'reviewRisk',
      'reviewConsistency', 'consensus', 'coveVerify', 'report',
    ];
    const validTiers: ModelTier[] = ['cheap', 'base', 'frontier'];
    
    const result: Record<string, string> = {};
    for (const [key, value] of Object.entries(parsed)) {
      if (!validSteps.includes(key as PipelineStep)) {
        console.warn(`[config] Unknown pipeline step in PIPELINE_MODEL_MAP: "${key}", ignoring`);
        continue;
      }
      if (!validTiers.includes(value as ModelTier)) {
        console.warn(`[config] Invalid tier "${value}" for step "${key}" in PIPELINE_MODEL_MAP, using default`);
        continue;
      }
      result[key] = value as string;
    }
    
    // Fill in any missing steps with defaults
    for (const step of validSteps) {
      if (!(step in result)) {
        result[step] = defaultMap[step];
      }
    }
    
    return result as unknown as Readonly<Record<PipelineStep, ModelTier>>;
  } catch (err) {
    console.warn(`[config] Failed to parse PIPELINE_MODEL_MAP, using defaults: ${err instanceof Error ? err.message : String(err)}`);
    return defaultMap;
  }
}

/**
 * Maps each pipeline step to its required LLM tier.
 *
 * The orchestrator reads this map at runtime to determine which model alias
 * and token budget to use for each step. The mapping is configurable via the
 * `PIPELINE_MODEL_MAP` environment variable (a JSON string); if parsing fails
 * or keys are missing, sensible defaults are used.
 *
 * ### Tier assignment rationale (defaults, overridable via ENV)
 *
 * | Step               | Tier       | Why                                                                      |
 * |--------------------|------------|--------------------------------------------------------------------------|
 * | landscapeScan      | cheap      | Broad, shallow scan — quantity over depth                                |
 * | riskMap            | base       | Needs structured reasoning but not frontier-level nuance                 |
 * | reviewLogic        | frontier   | Core logical correctness review — highest judgement required             |
 * | reviewRisk         | frontier   | Risk assessment benefits from the most capable reasoning                 |
 * | reviewConsistency  | base       | Cross-reference check — structured but not exploratory                   |
 * | consensus          | frontier   | Reconciling multiple reviewer outputs demands strong reasoning           |
 * | coveVerify         | base       | Single-step verification — decent quality suffices                       |
 * | report             | base       | Summarisation and formatting — no frontier reasoning needed              |
 */
export const PIPELINE_MODEL_MAP: Readonly<Record<PipelineStep, ModelTier>> = parseModelMap();

// ────────────────────────────────────────────────────────────────────────────
// Domain enums
// ────────────────────────────────────────────────────────────────────────────

/**
 * Epistemic-emotional tag that a reviewer LLM assigns to each finding.
 *
 * These tags encode the reviewer's confidence *and* affective stance toward the
 * finding, enabling downstream consumers to:
 * - **Prioritise** findings tagged `concerned` or `uneasy` over `satisfied`
 * - **Escalate** `confused` findings for human review (the LLM is uncertain)
 * - **Distinguish** `certain` high-confidence findings from `speculating`
 *   exploratory ones
 *
 * | Value        | Semantics                                                        |
 * |--------------|------------------------------------------------------------------|
 * | `certain`    | High confidence, no doubt about the finding                      |
 * | `uneasy`     | Confident something is off but can't pin it down precisely       |
 * | `speculating`| Exploratory — the finding is plausible but unverified            |
 * | `confused`   | The LLM lacks context to judge; recommend human review           |
 * | `satisfied`  | The reviewed code looks correct; no issue found                  |
 * | `concerned`  | Serious worry about correctness, security, or performance        |
 */
export const EMOTION = {
  certain: 'certain',
  uneasy: 'uneasy',
  speculating: 'speculating',
  confused: 'confused',
  satisfied: 'satisfied',
  concerned: 'concerned',
} as const;

/** Union type derived from {@link EMOTION}. */
export type Emotion = (typeof EMOTION)[keyof typeof EMOTION];

/**
 * Severity level for inline review comments in the final report.
 *
 * | Level      | Meaning                                                       |
 * |------------|---------------------------------------------------------------|
 * | `critical` | Must fix before merge — security, data-loss, or crash risk    |
 * | `warning`  | Should fix soon — code smell, maintainability, or perf issue  |
 * | `note`     | Informational — style, convention, or minor suggestion        |
 */
export const SEVERITY = {
  critical: 'critical',
  warning: 'warning',
  note: 'note',
} as const;

/** Union type derived from {@link SEVERITY}. */
export type Severity = (typeof SEVERITY)[keyof typeof SEVERITY];

// ────────────────────────────────────────────────────────────────────────────
// Pipeline artifact interfaces
// ────────────────────────────────────────────────────────────────────────────

/**
 * Artifact produced by the **landscape scan** step.
 *
 * Captures the high-level architectural context of the repository so that
 * downstream review steps can ground their analysis in the project's
 * conventions rather than applying generic rules.
 */
export interface LandscapeArtifact {
  /** High-level architectural style (e.g. "microservices", "monolith", "serverless"). */
  architecture: string;

  /** Recurring design patterns detected in the codebase (e.g. "repository", "factory"). */
  patterns: string[];

  /** Project-specific coding conventions (naming, file structure, error handling). */
  conventions: string[];

  /** Decisions that are intentional and should not be flagged as issues. */
  intentional: string[];
}

/**
 * A single entry in the **risk map** produced by the `riskMap` pipeline step.
 *
 * The risk map categorises every changed entity (and its transitive
 * dependencies) by blast radius so the review can allocate attention
 * proportionally.
 */
export interface RiskMapEntry {
  /** The entity that was directly changed in the diff (file, function, type, etc.). */
  changed: string;

  /** Entities that directly depend on the changed entity (first-order blast radius). */
  direct: string[];

  /** Entities that transitively depend on the changed entity (higher-order blast radius). */
  indirect: string[];

  /** Composite risk score (0–1) reflecting blast radius and change complexity. */
  risk: number;
}

/**
 * A single finding produced by any of the review steps
 * (`reviewLogic`, `reviewRisk`, `reviewConsistency`).
 *
 * Each finding represents a potential issue the reviewer identified, annotated
 * with confidence, emotional stance, and supporting evidence for traceability.
 */
export interface ReviewFinding {
  /** Human-readable description of the issue. */
  issue: string;

  /** File path (and optional line range) where the issue was found. */
  location: string;

  /** Description of the corner case or edge condition that triggers the issue. */
  cornerCase: string;

  /** Reviewer confidence in the finding, from 0 (speculative) to 1 (certain). */
  confidence: number;

  /** Epistemic-emotional tag indicating the reviewer's stance. */
  emotion: Emotion;

  /** Supporting evidence — code snippets, references, or logical reasoning. */
  evidence: string;
}

/**
 * A finding that has passed through the **consensus** step, where multiple
 * reviewer outputs are reconciled.
 *
 * The consensus step cross-references findings from the parallel review
 * branches and produces a single, deduplicated set with an agreed-upon status.
 */
export interface ConsensusFinding {
  /** Stable unique identifier (hash of issue + locations). Used as key for CoVe results. */
  id: string;

  /**
   * Outcome of consensus resolution.
   * - `agreed`    — all reviewers agree the issue is real
   * - `disputed`  — reviewers disagree; needs human adjudication
   * - `dismissed` — majority of reviewers reject the finding
   */
  status: 'agreed' | 'disputed' | 'dismissed';

  /** Description of the issue (may be a merged/rewritten version of the originals). */
  issue: string;

  /** Identifiers of the source {@link ReviewFinding}s that contributed to this consensus. */
  sources: string[];

  /** Merged location references from all source findings. */
  locations: string[];

  /** Consensus confidence — typically the median of source confidences. */
  confidence: number;

  /** Whether this finding should be escalated to a human reviewer. */
  escalate: boolean;

  /** Free-text reason for the escalation or status decision. */
  reason: string;
}

/**
 * A verification question generated by the **CoVe question generation** step.
 *
 * Each question targets a specific finding and probes whether the original
 * claim holds under scrutiny.
 */
export interface CoVeQuestion {
  /** Unique identifier for this question. */
  id: string;

  /** The finding this question is designed to verify. */
  findingId: string;

  /** The verification question in natural language. */
  question: string;
}

/**
 * An answer to a {@link CoVeQuestion}, produced by the **CoVe verifier** step.
 *
 * The verifier independently answers each question without access to the
 * original reviewer's reasoning, providing an unbiased check.
 */
export interface CoVeAnswer {
  /** The question this answer addresses. */
  questionId: string;

  /** The verifier's answer in natural language. */
  answer: string;

  /**
   * Whether the answer contradicts the original finding's claim.
   * - `true`  — the finding is likely a hallucination or error
   * - `false` — the finding appears consistent with the answer
   */
  contradicts: boolean;
}

/**
 * The final verdict for a single finding, produced by the **CoVe verdict** step.
 *
 * The verdict synthesises all verification answers for a finding and decides
 * whether it should be kept, revised, or dropped from the final report.
 */
export interface CoVeVerdict {
  /** The finding this verdict applies to. */
  findingId: string;

  /**
   * Outcome of the verification.
   * - `confirmed`  — all verification answers support the finding
   * - `revised`    — the finding was partially correct but needed amendment
   * - `rejected`   — verification contradicted the finding; it should be dropped
   */
  verdict: 'confirmed' | 'revised' | 'rejected';

  /** Human-readable justification for the verdict. */
  reasoning: string;
}

/**
 * A single inline comment in the final review report, tied to a specific
 * file and line range.
 */
export interface ReportInline {
  /** Relative file path within the repository. */
  file: string;

  /** Line number (or start line) the comment targets. */
  line: number;

  /** Severity level — determines visual prominence in the MR comment. */
  severity: Severity;

  /** The comment body (may contain Markdown). */
  body: string;
}

/**
 * The terminal output of the AI Code Review pipeline.
 *
 * Combines file-level inline comments (suitable for posting directly on a
 * GitLab merge request) with a free-form summary document.
 */
export interface ReviewOutput {
  /** Inline comments, one per finding, anchored to specific file/line locations. */
  inline: ReportInline[];

  /** Full review summary in Markdown — includes overview, risk assessment, and recommendations. */
  summary: string;
}
