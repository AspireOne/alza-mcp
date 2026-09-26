import { createHash, timingSafeEqual } from 'node:crypto';
import type { IncomingMessage } from 'node:http';
import { createRemoteJWKSet, errors, jwtVerify, type JWTVerifyGetKey } from 'jose';
import { fail } from './infra/failure.js';
import { log } from './infra/logger.js';

export type HttpAuth =
  | { mode: 'token'; token: string }
  | { mode: 'cloudflare-access'; teamDomain: string; audience: string; email: string; jwks?: JWTVerifyGetKey };

export function httpAuthFromEnv(env: NodeJS.ProcessEnv): HttpAuth {
  const mode = env.ALZA_HTTP_AUTH ?? 'token';
  if (mode === 'token') return { mode, token: env.ALZA_MCP_TOKEN ?? '' };
  if (mode === 'cloudflare-access') return {
    mode,
    teamDomain: env.ALZA_ACCESS_TEAM_DOMAIN ?? '',
    audience: env.ALZA_ACCESS_AUDIENCE ?? '',
    email: env.ALZA_ACCESS_EMAIL ?? '',
  };
  return fail('CONFIGURATION_ERROR', 'ALZA_HTTP_AUTH must be token or cloudflare-access.');
}

export function createHttpAuthorizer(auth: HttpAuth): (request: IncomingMessage) => Promise<'ok' | 'unauthorized' | 'unavailable'> {
  if (auth.mode === 'token') {
    if (auth.token.length < 32) fail('CONFIGURATION_ERROR', 'ALZA_MCP_TOKEN must contain at least 32 characters.');
    const expected = createHash('sha256').update(`Bearer ${auth.token}`).digest();
    return async request => {
      const actual = createHash('sha256').update(request.headers.authorization ?? '').digest();
      return timingSafeEqual(actual, expected) ? 'ok' : 'unauthorized';
    };
  }

  const { teamDomain, audience, email } = auth;
  if (!/^[a-z0-9.-]+$/i.test(teamDomain) || !teamDomain.includes('.') || !audience.trim() || !/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
    fail('CONFIGURATION_ERROR', 'Cloudflare Access requires ALZA_ACCESS_TEAM_DOMAIN, ALZA_ACCESS_AUDIENCE and ALZA_ACCESS_EMAIL.');
  }
  const issuer = `https://${teamDomain}`;
  const jwks = auth.jwks ?? createRemoteJWKSet(new URL(`${issuer}/cdn-cgi/access/certs`));
  return async request => {
    const token = request.headers['cf-access-jwt-assertion'];
    if (typeof token !== 'string' || !token) return 'unauthorized';
    try {
      const { payload } = await jwtVerify(token, jwks, {
        issuer, audience, algorithms: ['RS256'], requiredClaims: ['exp', 'iat', 'email', 'type'],
      });
      if (payload.type !== 'app' || typeof payload.email !== 'string' || payload.email.toLowerCase() !== email.toLowerCase()) return 'unauthorized';
      return 'ok';
    } catch (error) {
      if (error instanceof errors.JWKSTimeout || !(error instanceof errors.JOSEError)) {
        log.error('http.access_keys_unavailable', { name: error instanceof Error ? error.name : 'unknown' });
        return 'unavailable';
      }
      return 'unauthorized';
    }
  };
}
