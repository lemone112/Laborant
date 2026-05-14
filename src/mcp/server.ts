import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StdioServerTransport } from '@modelcontextprotocol/sdk/server/stdio.js';
import { z } from 'zod';
import { env } from '../config/env.js';
import { createGraphClient } from '../repo-intelligence/graph-sync.js';
import { createEmbeddingClient } from '../repo-intelligence/embedding-sync.js';
import { createLLMClient } from '../llm/client.js';
import { createBudgetTracker } from '../llm/budget.js';
import { runReviewPipeline } from '../pipeline/review.workflow.js';

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
    async ({ code, language: _language, context: _context }) => {
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
    async ({ files, repoPath: _repoPath }) => {
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
        const budget = createBudgetTracker();
        const llm = createLLMClient(budget);
        const embClient = createEmbeddingClient(env.QDRANT_URL);
        const embedFn = async (texts: string[]): Promise<number[][]> => {
          const result = await llm.embed(texts);
          return result.embeddings;
        };
        const results = await embClient.searchByCode(query, embedFn, limit);
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

        const budget = createBudgetTracker();
        const llm = createLLMClient(budget);
        const explanation = await llm.complete('base',
          'You are a code explainer. Explain the given symbol concisely based on available context.',
          context,
        );

        return { content: [{ type: 'text', text: explanation.content }] };
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
    // SSE transport — start a simple HTTP server
    const http = await import('node:http');
    const serverHttp = http.createServer(async (req, res) => {
      if (req.method === 'GET' && req.url === '/sse') {
        res.writeHead(200, {
          'Content-Type': 'text/event-stream',
          'Cache-Control': 'no-cache',
          Connection: 'keep-alive',
        });
        // SSE transport requires the MCP SDK SSE server transport
        // For now, send a heartbeat and note that full SSE requires @modelcontextprotocol/sdk/server/sse
        res.write('data: {"type":"heartbeat"}\n\n');
        req.on('close', () => res.end());
      } else {
        res.writeHead(404);
        res.end('Not found');
      }
    });
    serverHttp.listen(env.MCP_PORT, () => {
      console.error(`MCP SSE server listening on port ${env.MCP_PORT}`);
    });
  }
}

// Self-start when run directly
startMcpServer().catch((err) => {
  console.error('MCP server failed to start:', err);
  process.exit(1);
});
