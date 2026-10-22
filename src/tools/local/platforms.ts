import { z } from 'zod';

/** Liara platform ids (liara-cli AVAILABLE_PLATFORMS). */
export const PLATFORMS = ['node', 'next', 'react', 'vue', 'angular', 'static', 'laravel', 'php', 'django', 'flask', 'python', 'dotnet', 'go', 'docker'] as const;
export type Platform = (typeof PLATFORMS)[number];

export const platformSchema = z.enum(PLATFORMS).describe('Liara platform id');

/** Default ports as liara-cli resolves them (getPort/getDefaultPort). */
export function defaultPort(platform: string): number {
  switch (platform) {
    case 'static':
    case 'react':
    case 'vue':
    case 'angular':
    case 'laravel':
    case 'php':
    case 'django':
    case 'flask':
    case 'python':
    case 'dotnet':
      return 80;
    case 'go':
      return 8080;
    default:
      return 3000; // node, next, docker
  }
}

/** Platforms whose build output (dist/build) must be shipped as-is. */
export function isStaticPlatform(platform: string): boolean {
  return ['static', 'react', 'vue', 'angular'].includes(platform);
}
