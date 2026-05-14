import { env } from '../config/env.js';

// ── Types ──

export interface DiffRefs {
  base_sha: string;
  head_sha: string;
  start_sha: string;
}

export interface MRChange {
  old_path: string;
  new_path: string;
  diff: string;
  new_file: boolean;
  deleted_file: boolean;
  renamed_file: boolean;
}

export interface MRFile {
  old_path: string;
  new_path: string;
}

// ── Client ──

export function createGitLabClient(baseUrl: string = env.GITLAB_URL, token: string = env.GITLAB_TOKEN) {
  const headers: Record<string, string> = {
    'PRIVATE-TOKEN': token,
    'Content-Type': 'application/json',
  };

  async function request<T>(endpoint: string, options: RequestInit = {}): Promise<T> {
    const url = `${baseUrl}/api/v4${endpoint}`;
    let lastError: Error | undefined;

    for (let attempt = 0; attempt < 3; attempt++) {
      try {
        const res = await fetch(url, { ...options, headers: { ...headers, ...(options.headers as Record<string, string> ?? {}) } });
        if (!res.ok) {
          const body = await res.text().catch(() => '');
          throw new Error(`GitLab API ${res.status}: ${res.statusText} — ${body}`);
        }
        return await res.json() as T;
      } catch (err) {
        lastError = err instanceof Error ? err : new Error(String(err));
        if (attempt < 2) {
          await new Promise(r => setTimeout(r, 1000 * (attempt + 1)));
        }
      }
    }
    throw lastError;
  }

  return {
    /** Fetch the full diff of an MR */
    async getMRDiff(projectId: string, mrIid: number): Promise<{ changes: MRChange[]; diff_refs: DiffRefs }> {
      return request(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/changes`);
    },

    /** Fetch diff_refs for inline comment positioning */
    async getMRDiffRefs(projectId: string, mrIid: number): Promise<DiffRefs> {
      const data = await request<{ diff_refs: DiffRefs }>(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}`);
      return data.diff_refs;
    },

    /** Post an inline comment as a discussion thread */
    async postInlineComment(
      projectId: string,
      mrIid: number,
      comment: { file: string; line: number; body: string },
      diffRefs: DiffRefs,
    ): Promise<void> {
      const body: Record<string, any> = {
        body: comment.body,
        position: {
          base_sha: diffRefs.base_sha,
          start_sha: diffRefs.start_sha,
          head_sha: diffRefs.head_sha,
          new_path: comment.file,
          new_line: comment.line,
          position_type: 'text',
        },
      };

      try {
        await request(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/discussions`, {
          method: 'POST',
          body: JSON.stringify(body),
        });
      } catch {
        // Fallback: post as regular note without position
        await request(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`, {
          method: 'POST',
          body: JSON.stringify({ body: `**${comment.file}:${comment.line}**\n\n${comment.body}` }),
        });
      }
    },

    /** Post a summary note on the MR */
    async postSummaryNote(projectId: string, mrIid: number, summary: string): Promise<void> {
      await request(`/projects/${encodeURIComponent(projectId)}/merge_requests/${mrIid}/notes`, {
        method: 'POST',
        body: JSON.stringify({ body: summary }),
      });
    },

    /** Fetch a specific file's content from the MR branch */
    async getMRFileContent(projectId: string, mrIid: number, filePath: string): Promise<string | null> {
      try {
        const data = await request<{ content: string }>(
          `/projects/${encodeURIComponent(projectId)}/repository/files/${encodeURIComponent(filePath)}?ref=refs/merge-requests/${mrIid}/head`,
        );
        return Buffer.from(data.content, 'base64').toString('utf-8');
      } catch {
        return null;
      }
    },
  };
}

export type GitLabClient = ReturnType<typeof createGitLabClient>;
