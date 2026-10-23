'use client';

/**
 * Client session hook: stable session id (localStorage), replay on load, a live
 * EventSource for out-of-turn events (approval narration, alerts), and send()
 * streaming the turn over POST /api/chat. Events are deduped by id in the reducer.
 */
import { useCallback, useEffect, useReducer, useRef, useState } from 'react';
import type { AgentEvent } from '@/src/events';
import { fa } from '@/app/i18n/fa';
import { initialState, latestAssistant, reducer } from './reducer';

const SESSION_KEY = 'liara-agent:session';
const APP_KEY = 'liara-agent:app';
const STALE_TURN_MS = 5 * 60_000;
/** Longest we keep the composer locked waiting for the turn an approval starts. */
const AFTER_APPROVAL_MS = 3 * 60_000;

function read(key: string): string | null {
  try {
    return localStorage.getItem(key);
  } catch {
    return null;
  }
}

function write(key: string, value: string | null): void {
  try {
    if (value === null) localStorage.removeItem(key);
    else localStorage.setItem(key, value);
  } catch {
    // storage unavailable (private mode): keep in memory only
  }
}

/** Parses an SSE response body, calling onEvent for each `data:` payload. */
export async function readSse(res: Response, onEvent: (data: unknown) => void): Promise<void> {
  if (!res.body) return;
  const reader = res.body.getReader();
  const dec = new TextDecoder();
  let buf = '';
  for (;;) {
    const { value, done } = await reader.read();
    if (done) break;
    buf += dec.decode(value, { stream: true });
    let i: number;
    while ((i = buf.indexOf('\n\n')) >= 0) {
      const chunk = buf.slice(0, i);
      buf = buf.slice(i + 2);
      const data = chunk
        .split('\n')
        .filter((l) => l.startsWith('data:'))
        .map((l) => l.slice(5).trimStart())
        .join('\n');
      if (!data) continue;
      try {
        onEvent(JSON.parse(data));
      } catch {
        // ignore malformed frames
      }
    }
  }
}

export function useAgent() {
  const [state, dispatch] = useReducer(reducer, initialState);
  const [sessionId, setSessionId] = useState<string | null>(null);
  const [appName, setAppName] = useState<string | null>(null);
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [afterApproval, setAfterApproval] = useState(false);
  const appRef = useRef<string | null>(null);
  const sendingRef = useRef(false);
  /** `done` events still expected after an approval: the running chat turn's (if any), then the approval's own turn. */
  const donesLeft = useRef(0);
  const approvalTimer = useRef<ReturnType<typeof setTimeout> | undefined>(undefined);

  useEffect(() => {
    let id = read(SESSION_KEY);
    if (!id) {
      id = crypto.randomUUID();
      write(SESSION_KEY, id);
    }
    setSessionId(id);
    const app = read(APP_KEY);
    appRef.current = app;
    setAppName(app);
  }, []);

  useEffect(() => {
    if (!sessionId) return;
    let cancelled = false;
    fetch(`/api/events?sessionId=${sessionId}&replay=1`)
      .then((r) => r.json())
      .then((j: { events?: AgentEvent[] }) => {
        if (!cancelled && j.events?.length) dispatch({ type: 'events', events: j.events });
      })
      .catch(() => undefined);
    return () => {
      cancelled = true;
    };
  }, [sessionId]);

  useEffect(() => {
    if (!sessionId) return;
    const es = new EventSource(`/api/events?sessionId=${sessionId}${appName ? `&appName=${encodeURIComponent(appName)}` : ''}`);
    es.onmessage = (m) => {
      try {
        const event = JSON.parse(m.data) as AgentEvent;
        dispatch({ type: 'event', event });
        if (event.type === 'done' && donesLeft.current > 0 && --donesLeft.current === 0) setAfterApproval(false);
      } catch {
        // ignore
      }
    };
    return () => es.close();
  }, [sessionId, appName]);

  const send = useCallback(
    async (text: string) => {
      const body = text.trim();
      if (!body || !sessionId || sending) return;
      setError(null);
      setSending(true);
      sendingRef.current = true;
      try {
        const res = await fetch('/api/chat', {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId, appName: appRef.current, text: body }),
        });
        if (!res.ok) {
          const j = (await res.json().catch(() => ({}))) as { error?: string };
          setError(j.error ?? fa.errors.generic);
          return;
        }
        await readSse(res, (e) => dispatch({ type: 'event', event: e as AgentEvent }));
      } catch {
        setError(fa.errors.network);
      } finally {
        setSending(false);
        sendingRef.current = false;
      }
    },
    [sessionId, sending],
  );

  const approve = useCallback(async (approvalId: string, approved: boolean, typedName?: string): Promise<{ ok: boolean; error?: string }> => {
    // The approved action (or the decline reply) runs as its own turn after any turn still streaming;
    // count its `done` from before the request so a fast turn cannot slip past.
    donesLeft.current = sendingRef.current ? 2 : 1;
    const settle = () => {
      donesLeft.current = 0;
      setAfterApproval(false);
    };
    try {
      const res = await fetch('/api/approve', { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify({ approvalId, approved, typedName }) });
      const j = (await res.json().catch(() => ({}))) as { ok?: boolean; error?: string };
      if (!res.ok || !j.ok) {
        settle();
        return { ok: false, error: j.error ?? fa.errors.generic };
      }
      if (donesLeft.current > 0) setAfterApproval(true);
      clearTimeout(approvalTimer.current);
      approvalTimer.current = setTimeout(settle, AFTER_APPROVAL_MS);
      return { ok: true };
    } catch {
      settle();
      return { ok: false, error: fa.errors.network };
    }
  }, []);

  const selectApp = useCallback((name: string | null) => {
    appRef.current = name;
    write(APP_KEY, name);
    setAppName(name);
  }, []);

  const newConversation = useCallback(() => {
    const id = crypto.randomUUID();
    write(SESSION_KEY, id);
    donesLeft.current = 0;
    setAfterApproval(false);
    dispatch({ type: 'reset' });
    setSessionId(id);
  }, []);

  const turn = latestAssistant(state);
  const streaming = sending || afterApproval || Boolean(turn && !turn.done && Date.now() - Date.parse(turn.ts) < STALE_TURN_MS);
  return { state, sessionId, appName, streaming, error, send, approve, selectApp, newConversation };
}

export type AgentApi = ReturnType<typeof useAgent>;
