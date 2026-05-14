import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

/**
 * Load a prompt template from the prompts/ directory.
 * Prompts are stored as markdown files: prompts/{name}.md
 */
export async function loadPrompt(name: string): Promise<string> {
  const promptPath = resolve(import.meta.dirname, '../../prompts', `${name}.md`);
  return readFile(promptPath, 'utf-8');
}
