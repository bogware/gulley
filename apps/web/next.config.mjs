/** @type {import('next').NextConfig} */
const nextConfig = {
  reactStrictMode: true,
  // Web linting (next lint / eslint-config-next) is wired up in a later milestone;
  // don't fail production builds on it yet. TypeScript checking stays enabled.
  eslint: {
    ignoreDuringBuilds: true,
  },
};

export default nextConfig;
