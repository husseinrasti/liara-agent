import type { NextConfig } from 'next';

const nextConfig: NextConfig = {
  // Native / Node-only modules stay outside the server bundle.
  serverExternalPackages: ['better-sqlite3', 'pino', 'pino-pretty', 'ws', 'tar', 'dotenv'],
  poweredByHeader: false,
  // Keeps the dev badge out of the demo recording.
  devIndicators: false,
};

export default nextConfig;
