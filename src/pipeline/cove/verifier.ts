import type { CoVeAnswer, CoVeQuestion, LandscapeArtifact } from '../../config/defaults.js';
import { llmClient } from '../../llm/client.js';
import { budgetTracker } from '../../llm/budget.js';
import { loadPrompt } from '../../util/prompts.js';

/**
 * CoVe Step B — independent verification of questions.
 * CRITICAL: this call does NOT receive the original finding — only questions and code.
 * Uses `base` tier per PIPELINE_MODEL_MAP.
 */
export async function verifyQuestions(
  questions: CoVeQuestion[],
  diff: string,
  landscape: LandscapeArtifact,
): Promise<CoVeAnswer[]> {
  budgetTracker.checkBudget();

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
    questions.map(q => `Q: ${q.question}`).join('\n'),
    '',
    'For each question:',
    'Q: <restate question>',
    'ANSWER: <what code shows>',
    'EVIDENCE: <exact code anchor>',
    'CONTRADICTS: <yes/no — does this contradict the implied finding?>',
  ].join('\n');

  const result = await llmClient.complete('base', systemPrompt, userPrompt);
  return parseAnswers(result.content, questions);
}

function parseAnswers(raw: string, questions: CoVeQuestion[]): CoVeAnswer[] {
  const answers: CoVeAnswer[] = [];
  const blocks = raw.split(/(?=Q:)/g).filter(b => b.trim());

  for (let i = 0; i < blocks.length; i++) {
    const block = blocks[i];
    const answer = extractField(block, 'ANSWER');
    if (!answer) continue;

    const contradictsRaw = extractField(block, 'CONTRADICTS');

    answers.push({
      questionId: questions[i]?.id ?? `q-${i + 1}`,
      answer,
      contradicts: contradictsRaw?.toLowerCase() === 'yes',
    });
  }

  return answers;
}

function extractField(block: string, field: string): string | undefined {
  const regex = new RegExp(`${field}:\\s*(.+)`, 'i');
  const match = block.match(regex);
  return match?.[1]?.trim();
}
