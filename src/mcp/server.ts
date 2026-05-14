import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { env } from '../config/env.js';
import { createGraphClient } from '../repo-intelligence/graph-sync.js';
import { createEmbeddingClient } from '../repo-intelligence/embedding-sync.js';
import { llmClient } from '../llm/client.js';
import { runReviewPipeline } from '../pipeline/review.workflow.js';
import { budgetTracker } from '../llm/budget.js';

/**
 * MCP Server — exposes code review tools for AI agents.
 * Supports 'stdio' and 'sse' transport.
 */
export async function startMcpServer(): Promise<void> {
  const server = new McpServer({
    name: 'ai-code-review',
    version: '1.0.0',
  });

  // ── Tool 1: review_snippet ──
  server.tool(
    'review_snippet',
    'Full review of a code snippet or diff. Runs the complete pipeline.',
    {
      code: z.string().describe('Code or diff to review'),
      language: z.string().describe('Programming language'),
      context: z.string().optional().describe('Additional context about the code'),
    },
    async ({ code, language, context }) => {
      budgetTracker.reset();
      const result = await runReviewPipeline({
        mrIid: 0,
        projectId: 'mcp',
        diff: code,
        changedFiles: [],
      });

      if (!result.success || !result.output) {
        return { content: [{ type: 'text', text: `Review failed: ${result.error}` }] };
      }

      return {
        content: [{
          type: 'text',
          text: JSON.stringify(result.output, null, 2),
        }],
      };
    },
  );

  // ── Tool 2: check_risk ──
  server.tool(
    'check_risk',
    'Analyze risk propagation for changed files using the dependency graph.',
    {
      files: z.array(z.string()).describe('List of changed file paths'),
      repoPath: z.string().describe('Path to the repository'),
    },
    async ({ files, repoPath }) => {
      try {
        const graph = createGraphClient(env.NEO4J_URL, env.NEO4J_USER, env.NEO4J_PASSWORD);
        const dependents = await graph.getDependents(files, 3);
        await graph.close();
        return { content: [{ type: 'text', text: JSON.stringify(dependents, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Graph query failed: ${err}` }] };
      }
    },
  );

  // ── Tool 3: find_patterns ──
  server.tool(
    'find_patterns',
    'Semantic search for similar code patterns in the repository.',
    {
      query: z.string().describe('Search query describing the pattern'),
      limit: z.number().default(10).describe('Maximum results'),
    },
    async ({ query, limit }) => {
      try {
        const embClient = createEmbeddingClient(env.QDRANT_URL);
        const results = await embClient.searchByCode(query, (texts) => llmClient.embed(texts), limit);
        return { content: [{ type: 'text', text: JSON.stringify(results, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Pattern search failed: ${err}` }] };
      }
    },
  );

  // ── Tool 4: explain_symbol ──
  server.tool(
    'explain_symbol',
    'Explain a symbol (function/class) in the context of the codebase.',
    {
      symbolName: z.string().describe('Name of the symbol to explain'),
      filePath: z.string().optional().describe('File path hint'),
    },
    async ({ symbolName, filePath }) => {
      try {
        const graph = createGraphClient(env.NEO4J_URL, env.NEO4J_USER, env.NEO4J_PASSWORD);
        const files = filePath ? [filePath] : [];
        const dependents = files.length > 0
          ? await graph.getDirectDependents(files[0]!)
          : [];
        await graph.close();

        const context = dependents.length > 0
          ? `Symbol "${symbolName}" is used by: ${dependents.map((d: any) => d.file).join(', ')}`
          : `No dependency data for "${symbolName}"`;

        const explanation = await llmClient.complete('base',
          'You are a code explainer. Explain the given symbol concisely based on available context.',
          context,
        );

        return { content: [{ type: 'text', text: explanation }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Explain failed: ${err}` }] };
      }
    },
  );

  // ── Tool 5: query_graph ──
  server.tool(
    'query_graph',
    'Run a Cypher query against the dependency graph.',
    {
      query: z.string().describe('Cypher query string'),
      params: z.record(z.any()).optional().describe('Query parameters'),
    },
    async ({ query, params }) => {
      try {
        const graph = createGraphClient(env.NEO4J_URL, env.NEO4J_USER, env.NEO4J_PASSWORD);
        // For raw queries, use the driver directly
        const neo4j = await import('neo4j-driver');
        const driver = neo4j.default.driver(env.NEO4J_URL, neo4j.default.auth.basic(env.NEO4J_USER, env.NEO4J_PASSWORD));
        const session = driver.session();
        const result = await session.run(query, params ?? {});
        const records = result.records.map(r => r.toObject());
        await session.close();
        await driver.close();
        return { content: [{ type: 'text', text: JSON.stringify(records, null, 2) }] };
      } catch (err) {
        return { content: [{ type: 'text', text: `Graph query failed: ${err}` }] };
      }
    },
  );

  // ── Start ──
  if (env.MCP_TRANSPORT === 'stdio') {
    const transport = new StdioServerTransport();
    await server.connect(transport);
    console.error('MCP server running on stdio');
  } else {
    console.error(`MCP SSE transport not yet implemented — use stdio`);
    process.exit(1);
  }
}
