import { readFile } from 'node:fs/promises';
import { resolve, dirname } from 'node:path';
import { fileURLToPath } from 'node:url';

/**
 * Load a prompt template from the prompts/ directory.
 * Prompts are stored as markdown files: prompts/{name}.md
 */
export async function loadPrompt(name: string): Promise<string> {
  // Use fileURLToPath for broad Node.js compatibility (import.meta.dirname is Node 21+ only)
  const __filename = fileURLToPath(import.meta.url);
  const __dirname = dirname(__filename);
  const promptPath = resolve(__dirname, '../../prompts', `${name}.md`);
  return readFile(promptPath, 'utf-8');
}
