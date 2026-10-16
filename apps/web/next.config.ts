import path from 'node:path';
import type { NextConfig } from 'next';

const config: NextConfig = {
  transpilePackages: ['@events/shared', '@events/web-kit'],
  poweredByHeader: false,
  // Development only: let the dev server answer pages opened as 127.0.0.1 or a local-network address, not just localhost.
  allowedDevOrigins: ['127.0.0.1', '192.168.*.*', '10.*.*.*', '172.*.*.*'],
  // Do not generate AGENTS.md in the app folders when the dev server starts.
  agentRules: false,
  // Container images use the self-contained server output (Dockerfile sets NEXT_STANDALONE=1).
  ...(process.env.NEXT_STANDALONE ? { output: 'standalone' as const, outputFileTracingRoot: path.resolve(process.cwd(), '../..') } : {}),
  async headers() {
    return [{
      source: '/:path*',
      headers: [
        { key: 'X-Frame-Options', value: 'SAMEORIGIN' },
        { key: 'X-Content-Type-Options', value: 'nosniff' },
        { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
        { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=(self)' },
        { key: 'Content-Security-Policy', value: "object-src 'none'; base-uri 'self'; form-action 'self'; frame-ancestors 'self'" },
      ],
    }];
  },
};
export default config;
