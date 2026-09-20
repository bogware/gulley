/** @type {import('next').NextConfig} */

// The control-api the console proxies /control/* to is read at REQUEST time by
// app/control/[...path]/route.ts (CONTROL_API_URL), so one image serves any
// environment. (The previous rewrites() baked it in at build time.)
const isDev = process.env.NODE_ENV !== 'production';

// Browser talks only to its own origin (/control proxy) — plus a direct control-api
// origin when NEXT_PUBLIC_CONTROL_API_URL points off-origin (CORS setup).
const directApi = process.env.NEXT_PUBLIC_CONTROL_API_URL;
let connectExtra = '';
try {
  if (directApi && /^https?:\/\//.test(directApi)) connectExtra = ` ${new URL(directApi).origin}`;
} catch {
  /* ignore a malformed value; same-origin only */
}

const csp = [
  "default-src 'self'",
  // Next's hydration needs inline scripts; dev needs eval for HMR.
  `script-src 'self' 'unsafe-inline'${isDev ? " 'unsafe-eval'" : ''}`,
  "style-src 'self' 'unsafe-inline'",
  "img-src 'self' data: blob:",
  "font-src 'self' data:",
  `connect-src 'self'${connectExtra}`,
  "frame-ancestors 'none'",
  "base-uri 'self'",
  "form-action 'self'",
  "object-src 'none'",
].join('; ');

const securityHeaders = [
  { key: 'Content-Security-Policy', value: csp },
  { key: 'X-Content-Type-Options', value: 'nosniff' },
  { key: 'X-Frame-Options', value: 'DENY' },
  { key: 'Referrer-Policy', value: 'strict-origin-when-cross-origin' },
  { key: 'Permissions-Policy', value: 'camera=(), microphone=(), geolocation=()' },
];

const nextConfig = {
  reactStrictMode: true,
  // Web linting (next lint / eslint-config-next) is wired up in a later milestone;
  // don't fail production builds on it yet. TypeScript checking stays enabled.
  eslint: {
    ignoreDuringBuilds: true,
  },
  async headers() {
    return [{ source: '/:path*', headers: securityHeaders }];
  },
};

export default nextConfig;
