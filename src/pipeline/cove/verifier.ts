import type { CoVeAnswer, CoVeQuestion, LandscapeArtifact } from '../../config/defaults.js';
import type { LLMClient } from '../../llm/client.js';
import { loadPrompt } from '../../util/prompts.js';
import { requestStructured } from '../../util/structured-output.js';

/**
 * JSON schema describing the expected structured output from the
 * CoVe verification step.
 */
const VERIFIER_SCHEMA = `{
  "answers": [
    {
      "questionId": "<id of the question being answered>",
      "answer": "<what the code shows>",
      "contradicts": <true|false>
    }
  ]
}`;

/**
 * CoVe Step B — independent verification of questions.
 * CRITICAL: this call does NOT receive the original finding — only questions and code.
 * Uses `base` tier per PIPELINE_MODEL_MAP.
 *
 * Requests structured JSON output from the LLM and parses it directly,
 * eliminating regex-based field extraction.
 */
export async function verifyQuestions(
  questions: CoVeQuestion[],
  diff: string,
  landscape: LandscapeArtifact,
  llm: LLMClient,
): Promise<CoVeAnswer[]> {
  const systemPrompt = await loadPrompt('cove-verify');
  const userPrompt = [
    'Answer these questions about the code.',
    'You have not seen any review of this code.',
    'Answer only from what you can directly observe.',
    '',
    `<diff>${diff}</diff>`,
    `<landscape>${JSON.stringify(landscape)}</landscape>`,
    '',
    'Questions:',
    questions.map(q => `ID: ${q.id}\nQ: ${q.question}`).join('\n'),
  ].join('\n');

  const result = await requestStructured<{ answers?: unknown[] }>(
    llm,
    'base',
    systemPrompt,
    userPrompt,
    VERIFIER_SCHEMA,
  );

  const rawAnswers = Array.isArray(result.answers) ? result.answers : [];

  return rawAnswers.map((a: any, index: number) => ({
    questionId: String(a.questionId ?? questions[index]?.id ?? `q-${index + 1}`),
    answer: String(a.answer ?? ''),
    contradicts: Boolean(a.contradicts),
  }));
}
