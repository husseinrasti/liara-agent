/** Next.js instrumentation hook: Node-only setup lives in instrumentation-node.ts (keeps native modules out of the edge bundle). */
export async function register() {
  if (process.env.NEXT_RUNTIME === 'nodejs') {
    await import('./instrumentation-node');
  }
}
