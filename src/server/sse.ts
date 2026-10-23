/** Server-Sent Events response helper for the Next.js route handlers. */

export function sseResponse(
  signal: AbortSignal,
  setup: (send: (data: unknown) => void, close: () => void) => (() => void) | void,
  headers: Record<string, string> = {},
): Response {
  const enc = new TextEncoder();
  let closed = false;
  let cleanup: (() => void) | void;
  let ping: ReturnType<typeof setInterval> | undefined;
  const stream = new ReadableStream<Uint8Array>({
    start(controller) {
      const send = (data: unknown) => {
        if (closed) return;
        try {
          controller.enqueue(enc.encode(`data: ${JSON.stringify(data)}\n\n`));
        } catch {
          close();
        }
      };
      const close = () => {
        if (closed) return;
        closed = true;
        if (ping) clearInterval(ping);
        cleanup?.();
        try {
          controller.close();
        } catch {
          // already closed by the client
        }
      };
      controller.enqueue(enc.encode('retry: 3000\n\n'));
      ping = setInterval(() => {
        if (!closed) controller.enqueue(enc.encode(': ping\n\n'));
      }, 15_000);
      signal.addEventListener('abort', close);
      cleanup = setup(send, close);
    },
    cancel() {
      closed = true;
      if (ping) clearInterval(ping);
      cleanup?.();
    },
  });
  return new Response(stream, {
    headers: {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache, no-transform',
      Connection: 'keep-alive',
      'X-Accel-Buffering': 'no',
      ...headers,
    },
  });
}

export const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
