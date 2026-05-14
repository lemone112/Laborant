/**
 * @module util/finding-utils
 * @description Shared utilities for parsing and coercing review findings from LLM output.
 */

import { EMOTION, type Emotion } from '../config/defaults.js';

/**
 * Coerces an unknown value to a valid Emotion type.
 * Falls back to 'uneasy' if the value is not a recognized emotion.
 */
export function coerceEmotion(raw: unknown): Emotion {
  const val = String(raw ?? '').toLowerCase().trim();
  if ((Object.values(EMOTION) as string[]).includes(val)) {
    return val as Emotion;
  }
  return 'uneasy';
}

/**
 * Extracts a single-line field value from a text block using regex.
 * Used as a fallback when JSON parsing fails.
 *
 * @param block - The text block to search
 * @param field - The field name to extract (e.g. "ISSUE", "CONFIDENCE")
 * @returns The extracted value, or undefined if not found
 */
export function extractField(block: string, field: string): string | undefined {
  const regex = new RegExp(`${field}:\\s*(.+)`, 'i');
  const match = block.match(regex);
  return match?.[1]?.trim();
}

/**
 * Safely parses a confidence value from an LLM response.
 * Clamps to [0, 1] range.
 */
export function parseConfidence(raw: unknown): number {
  const num = Number(raw);
  if (Number.isNaN(num)) return 0.5;
  return Math.max(0, Math.min(1, num));
}
