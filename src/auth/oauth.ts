import { Request, Response, Router } from 'express';
import jwt from 'jsonwebtoken';

const JWT_SECRET = process.env.JWT_SECRET ?? 'change-me-in-production';
const CLIENT_ID = process.env.OAUTH_CLIENT_ID ?? 'wellows-mcp-client';
const ALLOWED_REDIRECT_URIS = (process.env.OAUTH_REDIRECT_URIS ?? 'https://claude.ai/oauth/callback').split(',');

export interface OAuthToken {
  sub: string;
  iat: number;
  exp: number;
  scope: string;
}

export function createOAuthRouter(): Router {
  const router = Router();

  // Authorization endpoint — Claude.ai redirects here to start OAuth
  router.get('/authorize', (req: Request, res: Response) => {
    const { client_id, redirect_uri, state, response_type } = req.query as Record<string, string>;

    if (client_id !== CLIENT_ID) {
      res.status(400).json({ error: 'invalid_client', error_description: 'Unknown client_id' });
      return;
    }

    if (!ALLOWED_REDIRECT_URIS.includes(redirect_uri)) {
      res.status(400).json({ error: 'invalid_request', error_description: 'Redirect URI not allowed' });
      return;
    }

    if (response_type !== 'code') {
      res.status(400).json({ error: 'unsupported_response_type' });
      return;
    }

    // Issue auth code directly (no user login required — server-to-server trust)
    const code = jwt.sign(
      { sub: 'wellows-mcp-user', scope: 'mcp:tools', redirect_uri },
      JWT_SECRET,
      { expiresIn: '10m' }
    );

    const callbackUrl = new URL(redirect_uri);
    callbackUrl.searchParams.set('code', code);
    if (state) callbackUrl.searchParams.set('state', state);

    res.redirect(callbackUrl.toString());
  });

  // Token endpoint — exchange auth code for access token
  router.post('/token', (req: Request, res: Response) => {
    const { grant_type, code, redirect_uri, client_id } = req.body as Record<string, string>;

    if (client_id !== CLIENT_ID) {
      res.status(401).json({ error: 'invalid_client' });
      return;
    }

    if (grant_type !== 'authorization_code') {
      res.status(400).json({ error: 'unsupported_grant_type' });
      return;
    }

    try {
      const decoded = jwt.verify(code, JWT_SECRET) as OAuthToken & { redirect_uri: string };

      if (decoded.redirect_uri !== redirect_uri) {
        res.status(400).json({ error: 'invalid_grant', error_description: 'redirect_uri mismatch' });
        return;
      }

      const accessToken = jwt.sign(
        { sub: decoded.sub, scope: decoded.scope },
        JWT_SECRET,
        { expiresIn: '1h' }
      );

      res.json({
        access_token: accessToken,
        token_type: 'bearer',
        expires_in: 3600,
        scope: decoded.scope,
      });
    } catch {
      res.status(400).json({ error: 'invalid_grant', error_description: 'Code expired or invalid' });
    }
  });

  return router;
}

export function verifyAccessToken(authHeader: string | undefined): OAuthToken | null {
  if (!authHeader?.startsWith('Bearer ')) return null;
  try {
    return jwt.verify(authHeader.slice(7), JWT_SECRET) as OAuthToken;
  } catch {
    return null;
  }
}
