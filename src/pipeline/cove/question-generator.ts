import type { CoVeQuestion, ConsensusFinding, LandscapeArtifact } from '../../config/defaults.js';
import type { LLMClient } from '../../llm/client.js';
import { loadPrompt } from '../../util/prompts.js';
import { requestStructured } from '../../util/structured-output.js';

/**
 * JSON schema describing the expected structured output from the
 * CoVe question generation step.
 */
const QUESTION_SCHEMA = `{
  "questions": [
    {
      "id": "<unique question identifier>",
      "question": "<specific, answerable by reading code>"
    }
  ]
}`;

/**
 * CoVe Step A — generate verification questions that could prove or disprove a finding.
 * Uses `cheap` tier per PIPELINE_MODEL_MAP.
 *
 * Requests structured JSON output from the LLM and parses it directly,
 * eliminating regex-based field extraction.
 */
export async function generateQuestions(
  finding: ConsensusFinding,
  diff: string,
  landscape: LandscapeArtifact,
  llm: LLMClient,
): Promise<CoVeQuestion[]> {
  const systemPrompt = await loadPrompt('cove-question');
  const userPrompt = [
    'Generate verification questions for this finding.',
    '',
    `<finding>${JSON.stringify(finding)}</finding>`,
    `<diff>${diff}</diff>`,
    `<landscape>${JSON.stringify(landscape)}</landscape>`,
    '',
    'MUST include at least one question designed to REFUTE.',
    'NEVER answer the questions.',
  ].join('\n');

  const result = await requestStructured<{ questions?: unknown[] }>(
    llm,
    'cheap',
    systemPrompt,
    userPrompt,
    QUESTION_SCHEMA,
  );

  const rawQuestions = Array.isArray(result.questions) ? result.questions : [];

  return rawQuestions.map((q: any, index: number) => ({
    id: String(q.id ?? `q-${index + 1}`),
    findingId: finding.issue,
    question: String(q.question ?? ''),
  })).filter(q => q.question.length > 0);
}
