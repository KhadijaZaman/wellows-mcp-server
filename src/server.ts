import 'dotenv/config';
import express, { Request, Response } from 'express';
import helmet from 'helmet';
import cors from 'cors';
import rateLimit from 'express-rate-limit';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import { registerCheckVisibilityTool } from './tools/checkVisibility.js';
import { registerExtractEntitiesTool } from './tools/extractEntities.js';
import { registerGenerateQueriesTool } from './tools/generateQueries.js';
import { registerInterpretScoreTool } from './tools/interpretScore.js';
import { createOAuthRouter } from './auth/oauth.js';

const PORT = parseInt(process.env.PORT ?? '3000', 10);
const IS_DEV = process.env.NODE_ENV !== 'production';

// Startup validation — fail fast rather than silently run insecure
if (!IS_DEV && (!process.env.JWT_SECRET || process.env.JWT_SECRET === 'change-me-in-production')) {
  console.error('FATAL: JWT_SECRET must be set to a strong secret in production.');
  process.exit(1);
}

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
app.set('trust proxy', 1);
app.use(helmet());
app.use(cors({
  origin: '*',
  methods: ['GET', 'POST', 'DELETE', 'OPTIONS'],
  allowedHeaders: ['Content-Type', 'Authorization', 'mcp-session-id'],
  exposedHeaders: ['mcp-session-id'],
}));
app.use(express.json({ limit: '1mb' }));

const mcpLimiter = rateLimit({
  windowMs: 60_000,
  max: 30,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

const oauthLimiter = rateLimit({
  windowMs: 60_000,
  max: 20,
  standardHeaders: true,
  legacyHeaders: false,
  message: { error: 'Too many requests, please slow down.' },
});

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
app.use('/oauth', oauthLimiter, createOAuthRouter());

// RFC 9728 — Protected Resource Metadata (Claude.ai fetches this FIRST from the MCP URL path)
app.get('/.well-known/oauth-protected-resource/mcp', (_req: Request, res: Response) => {
  const base = process.env.SERVER_URL ?? `http://localhost:${PORT}`;
  res.json({
    resource: `${base}/mcp`,
    authorization_servers: [base],
    bearer_methods_supported: ['header'],
    scopes_supported: ['mcp:tools'],
  });
});

// RFC 8414 — OAuth Authorization Server Metadata
app.get('/.well-known/oauth-authorization-server', (_req: Request, res: Response) => {
  const base = process.env.SERVER_URL ?? `http://localhost:${PORT}`;
  res.json({
    issuer: base,
    authorization_endpoint: `${base}/oauth/authorize`,
    token_endpoint: `${base}/oauth/token`,
    response_types_supported: ['code'],
    grant_types_supported: ['authorization_code'],
    code_challenge_methods_supported: ['S256'],
    token_endpoint_auth_methods_supported: ['none'],
  });
});

// OpenID configuration — fallback discovery endpoint
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

// MCP endpoint — fully stateless, new server+transport per request
app.post('/mcp', mcpLimiter, (req: Request, _res, next) => {
  const accept = req.headers['accept'] ?? '';
  if (!accept.includes('text/event-stream')) {
    req.headers['accept'] = 'application/json, text/event-stream';
  }
  next();
}, async (req: Request, res: Response) => {
  // AUTH DISABLED FOR TESTING — re-enable before production
  // if (!IS_DEV) {
  //   const token = verifyAccessToken(req.headers.authorization);
  //   if (!token) {
  //     const base = process.env.SERVER_URL ?? `http://localhost:${PORT}`;
  //     res.set('WWW-Authenticate', `Bearer realm="${base}", resource_metadata="${base}/.well-known/oauth-protected-resource/mcp"`);
  //     res.status(401).json({ error: 'Unauthorized' });
  //     return;
  //   }
  // }

  const server = createMcpServer();
  const transport = new StreamableHTTPServerTransport({
    sessionIdGenerator: undefined, // stateless — no session state needed
  });

  res.on('close', () => {
    transport.close();
    server.close();
  });

  await server.connect(transport);
  await transport.handleRequest(req, res, req.body);
});

// SSE notifications — not supported in stateless mode
app.get('/mcp', (_req: Request, res: Response) => {
  res.status(405).json({ error: 'method_not_allowed', message: 'SSE not supported in stateless mode' });
});

// Session close — no-op in stateless mode
app.delete('/mcp', (_req: Request, res: Response) => {
  res.status(200).json({ ok: true });
});

// Root — connectivity check
app.get('/', (_req: Request, res: Response) => {
  res.json({ service: 'wellows-mcp-server', version: '1.0.0', mcp: '/mcp' });
});

app.listen(PORT, () => {
  console.log(`Wellows MCP Server running on port ${PORT}`);
  console.log(`Health:   http://localhost:${PORT}/health`);
  console.log(`MCP:      http://localhost:${PORT}/mcp`);
  console.log(`OAuth:    http://localhost:${PORT}/oauth/authorize`);
});
