/** @type {import('next').NextConfig} */
const CONTROL_API_URL = process.env.CONTROL_API_URL ?? 'http://localhost:8081';

const nextConfig = {
  reactStrictMode: true,
  // Web linting (next lint / eslint-config-next) is wired up in a later milestone;
  // don't fail production builds on it yet. TypeScript checking stays enabled.
  eslint: {
    ignoreDuringBuilds: true,
  },
  // Proxy /control/* to the control-api so the browser talks to its own origin
  // (no CORS). Override the upstream with CONTROL_API_URL.
  async rewrites() {
    return [{ source: '/control/:path*', destination: `${CONTROL_API_URL}/:path*` }];
  },
};

export default nextConfig;
