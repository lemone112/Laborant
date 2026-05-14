import type { CoVeAnswer, CoVeQuestion, CoVeVerdict, ConsensusFinding } from '../../config/defaults.js';
import type { LLMClient } from '../../llm/client.js';
import { loadPrompt } from '../../util/prompts.js';
import { requestStructured } from '../../util/structured-output.js';

/**
 * JSON schema describing the expected structured output from the
 * CoVe verdict step.
 */
const VERDICT_SCHEMA = `{
  "verdict": "<confirmed|revised|rejected>",
  "reasoning": "<what verification revealed vs finding claimed>"
}`;

/**
 * CoVe Step C — render verdict comparing original finding against verification answers.
 * Uses `frontier` tier per PIPELINE_MODEL_MAP.
 *
 * Requests structured JSON output from the LLM and parses it directly,
 * eliminating regex-based field extraction.
 */
export async function renderVerdict(
  finding: ConsensusFinding,
  questions: CoVeQuestion[],
  answers: CoVeAnswer[],
  diff: string,
  llm: LLMClient,
): Promise<CoVeVerdict> {
  const systemPrompt = await loadPrompt('cove-verdict');

  const qaText = questions.map((q, i) => {
    const a = answers[i];
    return `Q: ${q.question}\nA: ${a?.answer ?? 'N/A'}\nCONTRADICTS: ${a?.contradicts ? 'yes' : 'no'}`;
  }).join('\n\n');

  const userPrompt = [
    'Render verdict on this finding using independent verification answers.',
    '',
    `<finding>${JSON.stringify(finding)}</finding>`,
    '',
    '<verification>',
    qaText,
    '</verification>',
    '',
    `<diff>${diff}</diff>`,
  ].join('\n');

  const result = await requestStructured<{ verdict?: unknown; reasoning?: unknown }>(
    llm,
    'frontier',
    systemPrompt,
    userPrompt,
    VERDICT_SCHEMA,
  );

  // Coerce the verdict to one of the three canonical values
  const verdictRaw = String(result.verdict ?? 'revised').toLowerCase();
  let verdict: CoVeVerdict['verdict'];

  if (verdictRaw === 'confirmed' || verdictRaw === 'partially_confirmed') {
    verdict = 'confirmed';
  } else if (verdictRaw === 'rejected' || verdictRaw === 'refuted') {
    verdict = 'rejected';
  } else {
    verdict = 'revised';
  }

  return {
    findingId: finding.issue,
    verdict,
    reasoning: String(result.reasoning ?? ''),
  };
}
