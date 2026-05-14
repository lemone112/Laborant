/**
 * @module util/structured-output
 * @description Helpers for requesting and parsing structured JSON output from LLMs.
 *
 * Centralises the pattern of:
 * 1. Appending JSON schema instructions to a system prompt.
 * 2. Requesting `jsonMode` from the LLM.
 * 3. Parsing the response with fallback extraction.
 *
 * Every pipeline step should use {@link requestStructured} instead of
 * hand-rolled regex parsing so that the output contract is enforced by
 * the model provider's JSON mode rather than fragile text splitting.
 */

import type { ILLMClient } from '../llm/client.js';
import type { ModelTier } from '../llm/tiers.js';

/**
 * Request structured JSON output from the LLM and parse it.
 *
 * Appends JSON schema instructions to the system prompt so the model
 * knows exactly what shape to produce, then requests `jsonMode: true`
 * from the provider. If the provider returns pre-parsed JSON (via
 * `result.parsed`), that is used directly; otherwise the raw content
 * is parsed with fallback extraction for markdown-wrapped JSON.
 *
 * @param llm              - The LLM client instance.
 * @param tier             - The model tier to use for this call.
 * @param systemPrompt     - The base system prompt (without JSON instructions).
 * @param userPrompt       - The user prompt containing the input data.
 * @param schemaDescription - A human-readable description of the expected JSON
 *                            structure, appended to the system prompt.
 * @returns The parsed JSON object typed as `T`.
 * @throws {Error} If the response cannot be parsed as valid JSON.
 *
 * @example
 * ```ts
 * const result = await requestStructured<{ findings: Array<{ issue: string }> }>(
 *   llm,
 *   'frontier',
 *   'You are a code reviewer.',
 *   'Review this diff: …',
 *   '{ "findings": [{ "issue": "<description>" }] }',
 * );
 * console.log(result.findings);
 * ```
 */
export async function requestStructured<T>(
  llm: ILLMClient,
  tier: ModelTier,
  systemPrompt: string,
  userPrompt: string,
  schemaDescription: string,
): Promise<T> {
  const jsonInstruction = [
    '',
    'RESPOND WITH VALID JSON ONLY. No markdown, no code blocks, no explanation outside JSON.',
    `Expected JSON structure:`,
    schemaDescription,
  ].join('\n');

  const result = await llm.complete(tier, systemPrompt + jsonInstruction, userPrompt, {
    jsonMode: true,
  });

  if (result.parsed) {
    return result.parsed as T;
  }

  // Fallback: try to extract JSON from the raw content
  const raw = result.content;
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch?.[1]) {
    try {
      return JSON.parse(jsonMatch[1].trim()) as T;
    } catch {
      // Fall through
    }
  }

  try {
    return JSON.parse(raw) as T;
  } catch {
    throw new Error(`Failed to parse structured output: ${raw.slice(0, 200)}`);
  }
}
