import { Router, type Request, type Response } from 'express';
import { timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';
import { createGitLabClient, type GitLabClient } from './api.js';
import { runReviewPipeline } from '../pipeline/review.workflow.js';

// ── Types ──

interface GitLabMREvent {
  object_kind: 'merge_request';
  event_type: string;
  user: { login: string };
  project: { id: number; path_with_namespace: string };
  object_attributes: {
    iid: number;
    action: 'open' | 'reopen' | 'update' | 'close' | 'merge';
    target_branch: string;
    source_branch: string;
  };
}

// ── Webhook Router ──

export function createWebhookRouter(): Router {
  const router = Router();
  const gitlab = createGitLabClient();

  router.post('/webhook/gitlab', async (req: Request, res: Response) => {
    // Validate token (timing-safe to prevent timing attacks)
    const token = req.headers['x-gitlab-token'] as string;
    if (!token || !env.GITLAB_WEBHOOK_SECRET) {
      res.status(403).json({ error: 'Invalid webhook token' });
      return;
    }
    try {
      const tokenBuf = Buffer.from(token);
      const secretBuf = Buffer.from(env.GITLAB_WEBHOOK_SECRET);
      if (tokenBuf.length !== secretBuf.length || !timingSafeEqual(tokenBuf, secretBuf)) {
        res.status(403).json({ error: 'Invalid webhook token' });
        return;
      }
    } catch {
      res.status(403).json({ error: 'Invalid webhook token' });
      return;
    }

    const event = req.body as GitLabMREvent;
    if (event.object_kind !== 'merge_request') {
      res.json({ status: 'ignored', reason: 'not a merge_request event' });
      return;
    }

    const action = event.object_attributes.action;
    if (!['open', 'reopen', 'update'].includes(action)) {
      res.json({ status: 'ignored', reason: `action ${action} not reviewable` });
      return;
    }

    const projectId = String(event.project.id);
    const mrIid = event.object_attributes.iid;

    // Acknowledge immediately — process async
    res.json({ status: 'accepted', projectId, mrIid });

    // Run review in background
    triggerReview(gitlab, projectId, mrIid).catch(err => {
      console.error(`Review failed for ${projectId}!${mrIid}:`, err);
    });
  });

  return router;
}

/**
 * Trigger a full review for an MR.
 */
export async function triggerReview(
  gitlab: GitLabClient,
  projectId: string,
  mrIid: number,
): Promise<Awaited<ReturnType<typeof runReviewPipeline>>> {
  console.log(`Starting review for ${projectId}!${mrIid}`);

  // Fetch diff and diff_refs
  const { changes, diff_refs } = await gitlab.getMRDiff(projectId, mrIid);
  const diff = changes.map(c => c.diff).join('\n');
  const changedFiles = changes.map(c => c.new_path);

  // Run pipeline (repoPath defaults to cwd if not cloning)
  const result = await runReviewPipeline({
    mrIid,
    projectId,
    diff,
    changedFiles,
    repoPath: env.REPO_PATH_FALLBACK ?? process.cwd(),
  });

  if (!result.success || !result.output) {
    console.error(`Review pipeline failed: ${result.error}`);
    return result;
  }

  // Post results to GitLab
  try {
    // Post inline comments
    for (const comment of result.output.inline) {
      await gitlab.postInlineComment(projectId, mrIid, comment, diff_refs);
    }

    // Post summary
    await gitlab.postSummaryNote(projectId, mrIid, result.output.summary);
    console.log(`Review posted to ${projectId}!${mrIid}: ${result.output.inline.length} inline comments`);
  } catch (err) {
    console.error(`Failed to post review to GitLab:`, err);
  }

  return result;
}
