import type { CoVeAnswer, CoVeQuestion, CoVeVerdict, ConsensusFinding } from '../../config/defaults.js';
import { llmClient } from '../../llm/client.js';
import { budgetTracker } from '../../llm/budget.js';
import { loadPrompt } from '../../util/prompts.js';

/**
 * CoVe Step C — render verdict comparing original finding against verification answers.
 * Uses `frontier` tier per PIPELINE_MODEL_MAP.
 */
export async function renderVerdict(
  finding: ConsensusFinding,
  questions: CoVeQuestion[],
  answers: CoVeAnswer[],
  diff: string,
): Promise<CoVeVerdict> {
  budgetTracker.checkBudget();

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
    '',
    'VERDICT: <confirmed / revised / rejected>',
    'REASONING: <what verification revealed vs finding claimed>',
  ].join('\n');

  const result = await llmClient.complete('frontier', systemPrompt, userPrompt);
  return parseVerdict(result.content, finding);
}

function parseVerdict(raw: string, finding: ConsensusFinding): CoVeVerdict {
  const verdictRaw = extractField(raw, 'VERDICT') ?? 'revised';

  // Map common variants to the three canonical values
  let verdict: CoVeVerdict['verdict'];
  const v = verdictRaw.toLowerCase();
  if (v === 'confirmed' || v === 'partially_confirmed') {
    verdict = 'confirmed';
  } else if (v === 'rejected' || v === 'refuted') {
    verdict = 'rejected';
  } else {
    verdict = 'revised';
  }

  return {
    findingId: finding.issue,
    verdict,
    reasoning: extractField(raw, 'REASONING') ?? '',
  };
}

function extractField(block: string, field: string): string | undefined {
  const regex = new RegExp(`${field}:\\s*(.+)`, 'i');
  const match = block.match(regex);
  return match?.[1]?.trim();
}
