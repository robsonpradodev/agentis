/**
 * Security headers middleware (D32, OWASP A05).
 *
 * Applied globally to every response. Values are conservative defaults
 * suitable for a self-hosted operator console:
 *   - X-Content-Type-Options: nosniff
 *   - X-Frame-Options: DENY  (defense-in-depth alongside CSP frame-ancestors)
 *   - Referrer-Policy: no-referrer
 *   - Cross-Origin-Opener-Policy: same-origin
 *   - Cross-Origin-Resource-Policy: same-origin
 *   - Permissions-Policy: camera=(), microphone=(), geolocation=()
 *   - Content-Security-Policy: see CSP below — allows the SPA chunk + ws:
 *     and tightens script/style sources. The dashboard uses Vite-built
 *     bundles so `'unsafe-inline'` is not needed for scripts; styles still
 *     allow inline because Tailwind component-level styles inject runtime
 *     classes via the runtime stylesheet.
 *   - Strict-Transport-Security: only when NODE_ENV=production. Local dev
 *     over http://localhost would otherwise be poisoned by HSTS.
 *
 * The headers are intentionally NOT applied to /v1/openapi.json or /v1/docs
 * via overrides — Scalar's docs page would break under a strict CSP. Both
 * mounts predate this middleware in `bootstrap.ts`; future tightening can
 * carve out exceptions if needed.
 */

import type { MiddlewareHandler } from 'hono';

export interface SecurityHeadersOptions {
  /** Set Strict-Transport-Security only in production. Defaults to false. */
  productionMode?: boolean;
}

const CSP = [
  "default-src 'self'",
  "script-src 'self'",
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  "manifest-src 'self'",
  "connect-src 'self' ws: wss:",
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

export function securityHeaders(opts: SecurityHeadersOptions = {}): MiddlewareHandler {
  const isProd = !!opts.productionMode;
  return async (c, next) => {
    await next();
    c.header('X-Content-Type-Options', 'nosniff');
    c.header('X-Frame-Options', 'DENY');
    c.header('Referrer-Policy', 'no-referrer');
    c.header('Cross-Origin-Opener-Policy', 'same-origin');
    c.header('Cross-Origin-Resource-Policy', 'same-origin');
    c.header('Permissions-Policy', 'camera=(), microphone=(), geolocation=()');
    c.header('Content-Security-Policy', CSP);
    if (isProd) {
      c.header('Strict-Transport-Security', 'max-age=31536000; includeSubDomains');
    }
  };
}
