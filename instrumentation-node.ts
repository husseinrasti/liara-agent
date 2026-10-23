/** Starts the background watcher once per server process (Node.js runtime only). */
import { getAgentRuntime } from './src/runtime';

try {
  getAgentRuntime().ensureWatcher();
} catch (err) {
  console.error('[liara-agent] watcher not started:', (err as Error).message);
}
