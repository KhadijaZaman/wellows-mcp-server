import 'dotenv/config';
import express, { Request, Response } from 'express';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { isInitializeRequest } from '@modelcontextprotocol/sdk/types.js';
import { randomUUID } from 'crypto';
import { registerCheckVisibilityTool } from './tools/checkVisibility.js';
import { registerExtractEntitiesTool } from './tools/extractEntities.js';
import { registerGenerateQueriesTool } from './tools/generateQueries.js';
import { registerInterpretScoreTool } from './tools/interpretScore.js';
import { createOAuthRouter, verifyAccessToken } from './auth/oauth.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);

// Per-session server map for stateful transports
const sessions = new Map<string, { server: McpServer; transport: StreamableHTTPServerTransport }>();

function createMcpServer(): McpServer {
  const server = new McpServer({
    name: 'wellows-mcp-server',
    version: '1.0.0',
  });

  registerCheckVisibilityTool(server);
  registerExtractEntitiesTool(server);
  registerGenerateQueriesTool(server);
  registerInterpretScoreTool(server);

  return server;
}

const app = express();
app.use(express.json({ limit: '10mb' }));

// Health check (no auth required)
app.get('/health', (_req: Request, res: Response) => {
  res.json({
    status: 'ok',
    service: 'wellows-mcp-server',
    version: '1.0.0',
    tools: ['check_ai_overviews_visibility', 'extract_domain_entities', 'generate_ai_overview_queries', 'interpret_citation_score'],
  });
});

// OAuth endpoints
app.use('/oauth', createOAuthRouter());

// OpenID configuration for Claude.ai discovery
app.get('/.well-known/openid-configuration', (_req: Request, res: Response) => {
  const base = process.env.SERVER_URL ?? `http://localhost:${PORT}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    token_endpoint_auth_methods_supported: ['client_secret_post', 'none'],
  });
});

// MCP connector metadata — used by Claude.ai public directory
app.get('/.well-known/mcp.json', (_req: Request, res: Response) => {
  const base = process.env.SERVER_URL ?? `http://localhost:${PORT}`;
  res.json({
    name: 'Wellows AI Overviews Tracker',
    description: 'Check any domain\'s citation score and visibility inside Google AI Overviews. Analyzes 40 intent-driven queries, detects explicit and implicit citations, measures average citation position, sentiment, and top competing domains. Powered by Wellows — the AI Visibility platform.',
    version: '1.0.0',
    url: `${base}/mcp`,
    logo_url: process.env.LOGO_URL ?? 'https://wellows.com/logo-512.png',
    contact_email: 'support@wellows.com',
    legal: {
      privacy_policy_url: 'https://wellows.com/privacy-policy/',
      terms_of_service_url: 'https://wellows.com/terms-of-service/',
    },
    oauth: {
      authorization_url: `${base}/oauth/authorize`,
      token_url: `${base}/oauth/token`,
      client_id: process.env.OAUTH_CLIENT_ID ?? 'wellows-mcp-client',
      scopes: ['mcp:tools'],
    },
    tools: [
      {
        name: 'check_ai_overviews_visibility',
        description: 'Full citation score analysis for a domain across Google AI Overviews. Takes 4-5 minutes.',
      },
      {
        name: 'extract_domain_entities',
        description: 'Extract brand entities, pain points, JTBDs, and goals from a domain. ~30-60 seconds.',
      },
      {
        name: 'generate_ai_overview_queries',
        description: 'Generate 40 high-intent queries designed to trigger Google AI Overviews for a domain.',
      },
      {
        name: 'interpret_citation_score',
        description: 'Benchmark a citation score and get a prioritized action plan.',
      },
    ],
    categories: ['seo', 'analytics', 'ai-visibility'],
    supported_languages: ['en'],
  });
});

// MCP endpoint — stateless (new server per request)
app.post('/mcp', async (req: Request, res: Response) => {
  // Verify auth if JWT_SECRET is configured beyond the default
  if (process.env.JWT_SECRET && process.env.JWT_SECRET !== 'change-me-in-production') {
    const token = verifyAccessToken(req.headers.authorization);
    if (!token) {
      res.status(401).json({ error: 'Unauthorized' });
      return;
    }
  }

  const sessionId = req.headers['mcp-session-id'] as string | undefined;

  if (sessionId && sessions.has(sessionId)) {
    // Resume existing session
    const session = sessions.get(sessionId)!;
    await session.transport.handleRequest(req, res, req.body);
    return;
  }

  if (!isInitializeRequest(req.body)) {
    res.status(400).json({ error: 'bad_request', message: 'Expected initialize request for new session' });
    return;
  }

  // New session
  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: () => randomUUID(),
    onsessioninitialized: (id) => {
      sessions.set(id, { server, transport });
    },
  });

  res.on('close', () => {
    if (transport.sessionId) {
      sessions.delete(transport.sessionId);
    }
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// SSE notifications (GET) and session close (DELETE)
app.get('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  await sessions.get(sessionId)!.transport.handleRequest(req, res);
});

app.delete('/mcp', async (req: Request, res: Response) => {
  const sessionId = req.headers['mcp-session-id'] as string | undefined;
  if (!sessionId || !sessions.has(sessionId)) {
    res.status(404).json({ error: 'Session not found' });
    return;
  }
  const session = sessions.get(sessionId)!;
  await session.transport.handleRequest(req, res);
  sessions.delete(sessionId);
});

app.listen(PORT, () => {
  console.log(`Wellows MCP Server running on port ${PORT}`);
  console.log(`Health:   http://localhost:${PORT}/health`);
  console.log(`MCP:      http://localhost:${PORT}/mcp`);
  console.log(`OAuth:    http://localhost:${PORT}/oauth/authorize`);
});
