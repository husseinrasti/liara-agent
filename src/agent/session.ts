/**
 * AgentSession: one conversation. Events are validated, persisted (text deltas
 * merged per segment so replays stay small) and published on the bus; model
 * history is persisted in `messages` and compacted when it grows large.
 */
import { randomUUID } from 'node:crypto';
import { generateText, type ModelMessage } from 'ai';
import { AgentEventSchema, type AgentEvent, type AgentEventInput } from '../events';
import type { AgentRuntime } from './runtime';

const COMPACT_TOKEN_LIMIT = 24_000;
const KEEP_RECENT = 20;

export const estimateTokens = (value: unknown) => Math.ceil(JSON.stringify(value).length / 3.5);

interface PendingText {
  id: string;
  ts: string;
  text: string;
}

export class AgentSession {
  history: ModelMessage[] = [];
  summary?: string;
  private pendingText: PendingText | null = null;

  private constructor(
    private readonly rt: AgentRuntime,
    readonly id: string,
    public appName?: string,
  ) {
    rt.bus.track(id, appName);
  }

  static create(rt: AgentRuntime, opts: { id?: string; appName?: string } = {}): AgentSession {
    const id = opts.id ?? randomUUID();
    const now = rt.now().toISOString();
    rt.deps.db.prepare('INSERT INTO sessions (id, appName, createdAt, lastActiveAt) VALUES (?, ?, ?, ?)').run(id, opts.appName ?? null, now, now);
    return new AgentSession(rt, id, opts.appName);
  }

  static load(rt: AgentRuntime, id: string): AgentSession | null {
    const row = rt.deps.db.prepare('SELECT id, appName FROM sessions WHERE id = ?').get(id) as { id: string; appName: string | null } | undefined;
    if (!row) return null;
    const s = new AgentSession(rt, row.id, row.appName ?? undefined);
    const msgs = rt.deps.db.prepare('SELECT role, content FROM messages WHERE sessionId = ? ORDER BY id').all(id) as { role: string; content: string }[];
    for (const m of msgs) {
      if (m.role === 'summary') s.summary = m.content;
      else s.history.push(JSON.parse(m.content) as ModelMessage);
    }
    return s;
  }

  static loadOrCreate(rt: AgentRuntime, id?: string, appName?: string): AgentSession {
    const s = id ? AgentSession.load(rt, id) : null;
    if (s) {
      if (appName && appName !== s.appName) s.setApp(appName);
      return s;
    }
    return AgentSession.create(rt, { id, appName });
  }

  setApp(appName: string | undefined): void {
    this.appName = appName;
    this.rt.deps.db.prepare('UPDATE sessions SET appName = ? WHERE id = ?').run(appName ?? null, this.id);
    this.rt.bus.track(this.id, appName);
  }

  touch(): void {
    this.rt.deps.db.prepare('UPDATE sessions SET lastActiveAt = ? WHERE id = ?').run(this.rt.now().toISOString(), this.id);
  }

  /** Stamps, validates, stores and publishes an event. Never throws. */
  emit = (input: AgentEventInput): AgentEvent => {
    const event = { ...input, id: randomUUID(), ts: this.rt.now().toISOString(), sessionId: this.id } as AgentEvent;
    const check = AgentEventSchema.safeParse(event);
    if (!check.success) this.rt.deps.logger.warn({ type: input.type, issue: check.error.issues[0]?.message }, 'event does not match the protocol');
    if (event.type === 'assistant_text_delta') {
      this.pendingText ??= { id: event.id, ts: event.ts, text: '' };
      this.pendingText.text += event.delta;
    } else {
      this.flushText();
      this.persist(event);
    }
    this.rt.bus.publish(event);
    return event;
  };

  /** Persists buffered text deltas as one merged delta event. */
  flushText(): void {
    if (!this.pendingText) return;
    const p = this.pendingText;
    this.pendingText = null;
    this.persist({ id: p.id, ts: p.ts, sessionId: this.id, type: 'assistant_text_delta', delta: p.text });
  }

  private persist(event: AgentEvent): void {
    try {
      this.rt.deps.db.prepare('INSERT INTO events (id, sessionId, type, payload, ts) VALUES (?, ?, ?, ?, ?)').run(event.id, this.id, event.type, JSON.stringify(event), event.ts);
    } catch (err) {
      this.rt.deps.logger.warn({ err: (err as Error).message }, 'failed to persist event');
    }
  }

  /** Last `limit` persisted events in order (for reload/replay). */
  replay(limit = 50): AgentEvent[] {
    const rows = this.rt.deps.db.prepare('SELECT payload FROM events WHERE sessionId = ? ORDER BY ts DESC, rowid DESC LIMIT ?').all(this.id, limit) as { payload: string }[];
    return rows.reverse().map((r) => JSON.parse(r.payload) as AgentEvent);
  }

  appendMessages(messages: ModelMessage[]): void {
    const insert = this.rt.deps.db.prepare('INSERT INTO messages (sessionId, role, content, createdAt) VALUES (?, ?, ?, ?)');
    const now = this.rt.now().toISOString();
    this.rt.deps.db.transaction(() => {
      for (const m of messages) insert.run(this.id, m.role, JSON.stringify(m), now);
    })();
    this.history.push(...messages);
  }

  /**
   * Keeps the last ~20 messages verbatim and folds older ones into a summary
   * (fast model) once the estimated history exceeds 24k tokens.
   */
  async compactIfNeeded(): Promise<boolean> {
    if (estimateTokens(this.history) <= COMPACT_TOKEN_LIMIT || this.history.length <= KEEP_RECENT) return false;
    let cut = this.history.length - KEEP_RECENT;
    while (cut > 0 && this.history[cut]!.role !== 'user') cut--; // never split a tool call from its result
    if (cut <= 0) return false;
    const older = this.history.slice(0, cut);
    const transcript = older
      .map((m) => `${m.role}: ${typeof m.content === 'string' ? m.content : JSON.stringify(m.content)}`.slice(0, 1500))
      .join('\n');
    const r = await generateText({
      model: this.rt.model('fast'),
      prompt: `Summarize this earlier part of a DevOps assistant conversation in at most 12 short bullet points (keep app names, actions taken, results, open questions, user preferences). Previous summary: ${this.summary ?? 'none'}\n\n${transcript}`,
      maxOutputTokens: 600,
    });
    this.summary = r.text.trim();
    this.history = this.history.slice(cut);
    const db = this.rt.deps.db;
    const now = this.rt.now().toISOString();
    db.transaction(() => {
      db.prepare('DELETE FROM messages WHERE sessionId = ?').run(this.id);
      db.prepare('INSERT INTO messages (sessionId, role, content, createdAt) VALUES (?, ?, ?, ?)').run(this.id, 'summary', this.summary, now);
      const insert = db.prepare('INSERT INTO messages (sessionId, role, content, createdAt) VALUES (?, ?, ?, ?)');
      for (const m of this.history) insert.run(this.id, m.role, JSON.stringify(m), now);
    })();
    return true;
  }
}
