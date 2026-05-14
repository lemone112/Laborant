/**
 * @module pipeline/feedback-gate
 * @description Feedback loop integration — checks historical false positive patterns
 * before the pipeline generates findings.
 *
 * If a pattern (finding text or issue type) was dismissed 3+ times by humans,
 * the pipeline automatically lowers confidence for similar findings and marks them
 * with 'speculating' emotion.
 *
 * This creates a learning feedback loop: human reviewers' actions improve future
 * automated reviews.
 */

import type { ConsensusFinding } from '../config/defaults.js';
import { feedbackTracker } from '../feedback/tracker.js';
import { logger, timer } from '../util/logger.js';

export interface FeedbackGateResult {
  /** Findings after applying feedback adjustments */
  findings: ConsensusFinding[];
  /** Number of findings that were adjusted due to feedback patterns */
  adjustedCount: number;
  /** Patterns that were matched */
  matchedPatterns: string[];
}

/**
 * Apply feedback-based adjustments to consensus findings.
 *
 * For each finding, check if similar patterns were previously dismissed.
 * If so, reduce confidence and change emotion to 'speculating'.
 *
 * @param findings - Consensus findings to adjust
 * @param projectId - The project ID to look up feedback for
 * @returns Adjusted findings with feedback context
 */
export async function applyFeedbackGate(
  findings: ConsensusFinding[],
  projectId: string,
): Promise<FeedbackGateResult> {
  const timed = timer('feedback_gate', projectId);

  let adjustedCount = 0;
  const matchedPatterns: string[] = [];

  try {
    const patterns = await feedbackTracker.getFalsePositivePatterns(projectId);

    // Build a set of patterns that were dismissed 3+ times
    const frequentPatterns = patterns.filter((p) => p.count >= 3);

    if (frequentPatterns.length === 0) {
      timed.end({ findingsCount: findings.length, adjustedCount: 0 });
      return { findings, adjustedCount: 0, matchedPatterns: [] };
    }

    const adjustedFindings = findings.map((finding) => {
      const isFalsePositive = frequentPatterns.some((pattern) => {
        // Simple pattern matching: check if the finding issue text
        // contains keywords from the false positive pattern
        const patternWords = pattern.pattern
          .toLowerCase()
          .split(/\s+/)
          .filter((w) => w.length > 3);

        const issueLower = finding.issue.toLowerCase();
        const matchCount = patternWords.filter((w) => issueLower.includes(w)).length;

        return matchCount >= 2 && matchCount / patternWords.length >= 0.5;
      });

      if (isFalsePositive) {
        adjustedCount++;
        matchedPatterns.push(finding.issue);
        return {
          ...finding,
          confidence: Math.min(finding.confidence, 0.4),
          escalate: false, // Don't escalate previously-dismissed patterns
          reason: `${finding.reason} [FEEDBACK: similar pattern dismissed ${frequentPatterns.find((p) => finding.issue.toLowerCase().includes(p.pattern.toLowerCase().split(/\s+/).filter((w) => w.length > 3)[0] ?? ''))?.count ?? 3}x]`,
        };
      }

      return finding;
    });

    timed.end({ findingsCount: findings.length, adjustedCount });
    return { findings: adjustedFindings, adjustedCount, matchedPatterns };
  } catch (err) {
    // Feedback gate failure is non-fatal
    logger.warn('Feedback gate failed (non-fatal), proceeding without adjustments', {
      step: 'feedback_gate',
      error: err instanceof Error ? err.message : String(err),
    });
    timed.end({ findingsCount: findings.length, adjustedCount: 0, error: true });
    return { findings, adjustedCount: 0, matchedPatterns: [] };
  }
}
