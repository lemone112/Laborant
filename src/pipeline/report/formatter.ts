import type { CoVeVerdict, ConsensusFinding, LandscapeArtifact, ReviewOutput } from '../../config/defaults.js';
import type { LLMClient } from '../../llm/client.js';
import { loadPrompt } from '../../util/prompts.js';
import { env } from '../../config/env.js';

/**
 * Report formatter — transforms verified findings into GitLab MR JSON.
 * Uses `base` tier per PIPELINE_MODEL_MAP.
 */
export async function formatReport(
  verifiedFindings: ConsensusFinding[],
  coveResults: Record<string, CoVeVerdict>,
  landscape: LandscapeArtifact,
  llm: LLMClient,
): Promise<ReviewOutput> {
  const systemPrompt = await loadPrompt('report');

  const findingsWithContext = verifiedFindings.map(f => ({
    ...f,
    coveVerdict: coveResults[f.issue]?.verdict ?? null,
  }));

  const userPrompt = [
    env.REVIEW_LANGUAGE === 'ru'
      ? 'Напиши ревью на русском. Выведи только валидный JSON.'
      : 'Write the review in English. Output only valid JSON.',
    '',
    `<landscape>${JSON.stringify(landscape)}</landscape>`,
    `<verified_findings>${JSON.stringify(findingsWithContext)}</verified_findings>`,
    '',
    'JSON структура:',
    '{',
    '  "inline": [{ "file": "<path>", "line": <n>, "severity": "<critical|warning|note>", "body": "<markdown>" }],',
    '  "summary": "<markdown>"',
    '}',
  ].join('\n');

  const result = await llm.complete('base', systemPrompt, userPrompt, {
    jsonMode: true,
  });

  return parseReportOutput(result.content);
}

function parseReportOutput(raw: string): ReviewOutput {
  let jsonStr = raw;

  // Handle ```json ... ``` wrapper
  const jsonMatch = raw.match(/```(?:json)?\s*([\s\S]*?)```/);
  if (jsonMatch?.[1]) {
    jsonStr = jsonMatch[1].trim();
  }

  try {
    const parsed = JSON.parse(jsonStr);
    return {
      inline: (parsed.inline ?? []).map((i: any) => ({
        file: String(i.file ?? ''),
        line: Number(i.line ?? 0),
        severity: ['critical', 'warning', 'note'].includes(i.severity)
          ? i.severity
          : 'note',
        body: String(i.body ?? ''),
      })),
      summary: String(parsed.summary ?? ''),
    };
  } catch {
    return {
      inline: [],
      summary: raw,
    };
  }
}
