import { env } from '../config/env.js';

// ── Types ──

export interface FeedbackInput {
  projectId: string;
  mrIid: number;
  findingId: string;
  action: 'accepted' | 'dismissed' | 'modified';
  comment?: string;
}

export interface FeedbackStats {
  total: number;
  accepted: number;
  dismissed: number;
  modified: number;
  dismissalRate: number;
}

export interface FalsePositivePattern {
  pattern: string;
  count: number;
  exampleFindings: string[];
}

// ── Simple PG client (node-pg compatible) ──

let pool: any = null;

async function getPool() {
  if (pool) return pool;
  const pg = await import('pg');
  pool = new pg.default.Pool({ connectionString: env.DATABASE_URL });
  return pool;
}

// ── Tracker ──

export class FeedbackTracker {
  /**
   * Ensure the feedback table exists.
   */
  async ensureSchema(): Promise<void> {
    const p = await getPool();
    await p.query(`
      CREATE TABLE IF NOT EXISTS review_feedback (
        id SERIAL PRIMARY KEY,
        project_id TEXT NOT NULL,
        mr_iid INTEGER NOT NULL,
        finding_id TEXT NOT NULL,
        action TEXT NOT NULL CHECK (action IN ('accepted', 'dismissed', 'modified')),
        comment TEXT,
        created_at TIMESTAMPTZ DEFAULT NOW()
      );
      CREATE INDEX IF NOT EXISTS idx_feedback_project_mr ON review_feedback(project_id, mr_iid);
      CREATE INDEX IF NOT EXISTS idx_feedback_action ON review_feedback(action);
    `);
  }

  /**
   * Record human review feedback.
   */
  async recordFeedback(input: FeedbackInput): Promise<void> {
    const p = await getPool();
    await p.query(
      `INSERT INTO review_feedback (project_id, mr_iid, finding_id, action, comment) VALUES ($1, $2, $3, $4, $5)`,
      [input.projectId, input.mrIid, input.findingId, input.action, input.comment ?? null],
    );
  }

  /**
   * Get aggregated feedback statistics for a project.
   */
  async getFeedbackStats(projectId: string): Promise<FeedbackStats> {
    const p = await getPool();
    const result = await p.query(
      `SELECT action, COUNT(*) as count FROM review_feedback WHERE project_id = $1 GROUP BY action`,
      [projectId],
    );

    const rows = result.rows as { action: string; count: string }[];
    const total = rows.reduce((sum, r) => sum + Number(r.count), 0);
    const accepted = Number(rows.find(r => r.action === 'accepted')?.count ?? 0);
    const dismissed = Number(rows.find(r => r.action === 'dismissed')?.count ?? 0);
    const modified = Number(rows.find(r => r.action === 'modified')?.count ?? 0);

    return {
      total,
      accepted,
      dismissed,
      modified,
      dismissalRate: total > 0 ? dismissed / total : 0,
    };
  }

  /**
   * Find common patterns in dismissed findings (false positive patterns).
   */
  async getFalsePositivePatterns(projectId: string): Promise<FalsePositivePattern[]> {
    const p = await getPool();
    const result = await p.query(
      `SELECT finding_id, COUNT(*) as count FROM review_feedback
       WHERE project_id = $1 AND action = 'dismissed'
       GROUP BY finding_id
       ORDER BY count DESC
       LIMIT 20`,
      [projectId],
    );

    return (result.rows as { finding_id: string; count: string }[]).map(r => ({
      pattern: r.finding_id,
      count: Number(r.count),
      exampleFindings: [r.finding_id],
    }));
  }
}

/** Singleton tracker instance */
export const feedbackTracker = new FeedbackTracker();
