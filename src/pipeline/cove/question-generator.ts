import type { CoVeQuestion, ConsensusFinding, LandscapeArtifact } from '../../config/defaults.js';
import { llmClient } from '../../llm/client.js';
import { budgetTracker } from '../../llm/budget.js';
import { loadPrompt } from '../../util/prompts.js';

/**
 * CoVe Step A — generate verification questions that could prove or disprove a finding.
 * Uses `cheap` tier per PIPELINE_MODEL_MAP.
 */
export async function generateQuestions(
  finding: ConsensusFinding,
  diff: string,
  landscape: LandscapeArtifact,
): Promise<CoVeQuestion[]> {
  budgetTracker.checkBudget();

  const systemPrompt = await loadPrompt('cove-question');
  const userPrompt = [
    'Generate verification questions for this finding.',
    '',
    `<finding>${JSON.stringify(finding)}</finding>`,
    `<diff>${diff}</diff>`,
    `<landscape>${JSON.stringify(landscape)}</landscape>`,
    '',
    'For each question:',
    'Q: <specific, answerable by reading code>',
    'TESTS: <confirms / refutes / either>',
    'LOCATION: <where in code to look>',
    '',
    'MUST include at least one question designed to REFUTE.',
    'NEVER answer the questions.',
  ].join('\n');

  const result = await llmClient.complete('cheap', systemPrompt, userPrompt);
  return parseQuestions(result.content, finding.issue);
}

function parseQuestions(raw: string, findingId: string): CoVeQuestion[] {
  const questions: CoVeQuestion[] = [];
  const blocks = raw.split(/(?=Q:)/g).filter(b => b.trim());

  for (const block of blocks) {
    const q = extractField(block, 'Q');
    if (!q) continue;

    questions.push({
      id: `q-${questions.length + 1}`,
      findingId,
      question: q,
    });
  }

  return questions;
}

function extractField(block: string, field: string): string | undefined {
  const regex = new RegExp(`${field}:\\s*(.+)`, 'i');
  const match = block.match(regex);
  return match?.[1]?.trim();
}
