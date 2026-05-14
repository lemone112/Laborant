import 'dotenv/config';
import express from 'express';
import { validateEnv } from './config/env.js';
import { createWebhookRouter } from './gitlab/webhook.js';
import { feedbackTracker } from './feedback/tracker.js';
import { env } from './config/env.js';

async function main() {
  // Fail-fast if ENV is misconfigured
  validateEnv();

  console.log('Laborant — AI Code Review Pipeline starting...');
  console.log(`LLM_BASE_URL: ${env.LLM_BASE_URL}`);
  console.log(`Cheap: ${env.LLM_CHEAP_MODEL} | Base: ${env.LLM_BASE_MODEL} | Frontier: ${env.LLM_FRONTIER_MODEL} | Embedding: ${env.LLM_EMBEDDING_MODEL}`);

  // Ensure DB schema
  try {
    await feedbackTracker.ensureSchema();
    console.log('Feedback DB schema ready');
  } catch (err) {
    console.warn('Feedback DB not available (non-critical):', (err as Error).message);
  }

  // HTTP API + Webhook
  const app = express();
  app.use(express.json({ limit: '10mb' }));

  // Health check
  app.get('/health', (_req, res) => {
    res.json({ status: 'ok', version: '1.0.0' });
  });

  // GitLab webhook
  app.use(createWebhookRouter());

  // Manual trigger endpoint
  app.post('/api/review', async (req, res) => {
    const { projectId, mrIid } = req.body as { projectId?: string; mrIid?: number };
    if (!projectId || !mrIid) {
      res.status(400).json({ error: 'projectId and mrIid required' });
      return;
    }
    res.json({ status: 'accepted' });
    // Process async
    const { createGitLabClient } = await import('./gitlab/api.js');
    const { triggerReview } = await import('./gitlab/webhook.js');
    const gitlab = createGitLabClient();
    triggerReview(gitlab, projectId, mrIid).catch(err => {
      console.error(`Manual review failed:`, err);
    });
  });

  // Start server
  const port = env.API_PORT;
  app.listen(port, () => {
    console.log(`API server listening on port ${port}`);
    console.log(`Webhook endpoint: POST http://localhost:${port}/webhook/gitlab`);
    console.log(`Manual trigger: POST http://localhost:${port}/api/review`);
  });
}

main().catch(err => {
  console.error('Fatal startup error:', err);
  process.exit(1);
});
