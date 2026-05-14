import 'dotenv/config';
import { validateEnv } from './config/env.js';
import { env } from './config/env.js';

/**
 * Temporal worker — registers all workflows and activities.
 * Run separately from the API server: `tsx src/worker.ts`
 */
async function main() {
  validateEnv();

  console.log('Starting Temporal worker...');
  console.log(`Connecting to Temporal at ${env.TEMPORAL_URL}`);

  try {
    const { Worker } = await import('@temporalio/worker');

    const worker = await Worker.create({
      workflowsPath: require.resolve('./pipeline/review.workflow.js'),
      taskQueue: 'ai-code-review',
      connection: {
        address: env.TEMPORAL_URL,
      },
      namespace: env.TEMPORAL_NAMESPACE,
    });

    console.log('Worker connected. Listening for tasks...');
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
