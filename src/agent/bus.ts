/** In-process pub/sub for session events (SSE routes subscribe per session; the watcher broadcasts per app). */
import { EventEmitter } from 'node:events';
import type { AgentEvent } from '../events';

export class EventBus {
  private readonly emitter = new EventEmitter();
  /** sessionId → appName, so app-level broadcasts (alerts) reach open sessions. */
  private readonly sessionApps = new Map<string, string | undefined>();

  constructor() {
    this.emitter.setMaxListeners(0);
  }

  publish(event: AgentEvent): void {
    this.emitter.emit(`s:${event.sessionId}`, event);
    this.emitter.emit('*', event);
  }

  subscribe(sessionId: string, fn: (e: AgentEvent) => void): () => void {
    this.emitter.on(`s:${sessionId}`, fn);
    return () => this.emitter.off(`s:${sessionId}`, fn);
  }

  subscribeAll(fn: (e: AgentEvent) => void): () => void {
    this.emitter.on('*', fn);
    return () => this.emitter.off('*', fn);
  }

  /** Registers which app a live session is looking at. */
  track(sessionId: string, appName: string | undefined): void {
    this.sessionApps.set(sessionId, appName);
  }

  untrack(sessionId: string): void {
    this.sessionApps.delete(sessionId);
  }

  /** Live sessions currently focused on `appName`. */
  sessionsForApp(appName: string): string[] {
    return [...this.sessionApps.entries()].filter(([, a]) => a === appName).map(([s]) => s);
  }
}
