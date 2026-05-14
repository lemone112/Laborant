import 'dotenv/config';
import { validateEnv } from './config/env.js';
import { env } from './config/env.js';
import { Worker } from '@temporalio/worker';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';
import * as activities from './pipeline/activities.js';
import * as reindexActivities from './repo-intelligence/reindex.activities.js';

async function main() {
  validateEnv();

  console.log('Starting Temporal worker...');
  console.log(`Connecting to Temporal at ${env.TEMPORAL_URL}`);

  try {
    const __filename = fileURLToPath(import.meta.url);
    const __dirname = dirname(__filename);

    const worker = await Worker.create({
      workflowsPath: join(__dirname, 'pipeline', 'review.workflow.js'),
      activities: {
        ...activities,
        ...reindexActivities,
      },
      taskQueue: 'ai-code-review',
      namespace: env.TEMPORAL_NAMESPACE,
    });

    console.log('Worker connected. Listening for tasks on queue "ai-code-review"...');
    console.log('Registered activities: review pipeline + reindex pipeline');
    await worker.run();
  } catch (err) {
    console.error('Failed to start Temporal worker:', err);
    console.error('Make sure Temporal server is running at', env.TEMPORAL_URL);
    process.exit(1);
  }
}

main().catch(err => {
  console.error('Fatal worker error:', err);
  process.exit(1);
});
