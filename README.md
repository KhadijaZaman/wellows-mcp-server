# Wellows AI Overviews Tracker — Remote MCP Server

A production-ready [Model Context Protocol](https://modelcontextprotocol.io) (MCP) server that exposes Wellows' AI Overviews visibility analysis tools to Claude and other MCP-compatible AI clients.

**Live endpoint:** `https://wellows-mcp-server-production.up.railway.app/mcp`

---

## What It Does

Connects Claude directly to the [Wellows](https://wellows.com) AI Visibility platform. Ask Claude to check any domain's citation score inside Google AI Overviews and get a full breakdown — no dashboard login required.

Example prompts:
- *"Check AI Overviews visibility for purevpn.com"*
- *"Extract the brand entities from notion.so"*
- *"Generate AI Overview queries for my SaaS at example.com"*
- *"My citation score is 8.5% — what should I do?"*

---

## Tools

| Tool | Description | Time |
|---|---|---|
| `check_ai_overviews_visibility` | Full citation score — scrapes domain, generates 40 queries, scans live AI Overviews, returns scorecard | ~4-5 min |
| `extract_domain_entities` | Extracts brand entities, pain points, JTBDs, and goals from a domain | ~30-60 sec |
| `generate_ai_overview_queries` | Generates 40 intent-driven queries designed to trigger AI Overviews | ~60-90 sec |
| `interpret_citation_score` | Benchmarks a score, explains what it means, returns prioritized action plan | Instant |

---

## Add to Claude

1. Go to [claude.ai](https://claude.ai) → Settings → Integrations
2. Click **Add custom integration**
3. Enter: `https://wellows-mcp-server-production.up.railway.app/mcp`
4. Complete the OAuth flow
5. Start using the tools in any conversation

---

## Self-Host / Deploy

### Prerequisites
- Node.js 20+
- Railway account (or any platform that supports Docker)

### Local Development

```bash
git clone https://github.com/KhadijaZaman/wellows-mcp-server.git
cd wellows-mcp-server
npm install
cp .env.example .env
# Edit .env — set at minimum WELLOWS_BASE_URL
npm run dev
```

### Deploy to Railway

1. Fork this repo
2. Go to [railway.app](https://railway.app) → New Project → Deploy from GitHub
3. Select your fork — Railway detects the Dockerfile automatically
4. Set environment variables (see below)
5. Go to Settings → Networking → Generate Domain

### Environment Variables

| Variable | Required | Description |
|---|---|---|
| `WELLOWS_BASE_URL` | Yes | `https://wellows.com` |
| `JWT_SECRET` | Yes (production) | Random 64-char secret — run `openssl rand -hex 32` |
| `SERVER_URL` | Yes | Your public HTTPS URL, e.g. `https://your-app.up.railway.app` |
| `OAUTH_CLIENT_ID` | No | Default: `wellows-mcp-client` |
| `OAUTH_REDIRECT_URIS` | No | Default: `https://claude.ai/oauth/callback` |
| `LOGO_URL` | No | 512×512 PNG for connector directory listing |
| `PORT` | No | Default: `3000` (Railway sets this automatically) |

> **Note:** `JWT_SECRET` must be set in production. The server will refuse to start without it.

---

## Architecture

```
src/
├── server.ts              # Express app — MCP endpoint, OAuth, security middleware
├── tools/
│   ├── checkVisibility.ts # Tool: full AI Overviews citation scan
│   ├── extractEntities.ts # Tool: brand entity extraction
│   ├── generateQueries.ts # Tool: AI Overview query generation
│   └── interpretScore.ts  # Tool: score benchmarking + recommendations
├── client/
│   └── wellowsClient.ts   # Wellows API client — 4-step pipeline with polling
├── auth/
│   └── oauth.ts           # OAuth 2.0 authorization code flow (JWT-based)
└── types/
    └── index.ts           # TypeScript types from verified API payloads
```

**Pipeline flow for `check_ai_overviews_visibility`:**
1. Scrape domain → `POST /api/isqgt/scrape-domain`
2. Extract entities → `POST /api/isqgt/extract-entities` + poll
3. Generate queries → `POST /api/isqgt/generate-queries` + poll
4. SERP search → `POST /api/ai-overviews-tracker/serp-search/` (batched, 5 queries/batch)
5. Aggregate + format scorecard

---

## Security

- **Auth enforced in production** — all `/mcp` requests require a valid Bearer token issued via OAuth
- **Startup validation** — server refuses to start if `JWT_SECRET` is missing or default in production
- **Security headers** — `helmet` sets `X-Frame-Options`, `X-Content-Type-Options`, CSP, and more
- **Rate limiting** — `/mcp` capped at 30 req/min, `/oauth` at 20 req/min per IP
- **Request size** — body limit capped at 1MB
- **OAuth redirect URI allowlist** — only pre-configured URIs accepted

---

## Connector Directory

Metadata endpoint: `https://wellows-mcp-server-production.up.railway.app/.well-known/mcp.json`

- Privacy Policy: https://wellows.com/privacy-policy/
- Terms of Service: https://wellows.com/terms-of-service/
- Contact: support@wellows.com

---

## License

MIT — see [LICENSE](LICENSE)

Built by [Wellows](https://wellows.com) — the AI Visibility platform.
