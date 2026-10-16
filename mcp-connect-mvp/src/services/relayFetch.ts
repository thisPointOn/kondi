/**
 * fetch-compatible shim over the `http_relay_stream` Tauri command. reqwest on
 * the Rust side is not subject to CORS, and response bytes are forwarded over
 * an IPC channel AS THEY ARRIVE — so SSE token deltas stream live (a buffered
 * relay trips the chat's 90s no-first-byte watchdog on long generations).
 * AbortSignal rejects/errors the webview side; the backend request then just
 * runs out on its own.
 *
 * Lives in its own module so BOTH the OpenAI-compatible client (NVIDIA NIM,
 * which sends no CORS headers) and the agent-runtime adapters can use it.
 * Webview-only (imports Tauri); never import from Node code.
 */
import { invoke, Channel } from '@tauri-apps/api/core';

type RelayStreamEvent =
  | { type: 'status'; status: number; headers: Record<string, string> }
  | { type: 'chunk'; data: string }
  | { type: 'end' }
  | { type: 'error'; message: string };

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const bytes = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) bytes[i] = bin.charCodeAt(i);
  return bytes;
}

export const relayFetch: typeof fetch = (input, init) => {
  const url = typeof input === 'string' ? input : input instanceof URL ? input.toString() : input.url;
  const headers: Record<string, string> = {};
  new Headers(init?.headers).forEach((v, k) => { headers[k] = v; });
  const signal = init?.signal;

  return new Promise<Response>((resolve, reject) => {
    let controller: ReadableStreamDefaultController<Uint8Array> | null = null;
    let settled = false; // response resolved/rejected
    let done = false;    // stream closed/errored

    const stream = new ReadableStream<Uint8Array>({
      start(c) { controller = c; },
    });

    const fail = (err: Error) => {
      if (!settled) { settled = true; reject(err); }
      else if (!done) { done = true; try { controller?.error(err); } catch { /* already closed */ } }
    };

    if (signal) {
      const onAbort = () => fail(new DOMException('The operation was aborted.', 'AbortError'));
      if (signal.aborted) { onAbort(); return; }
      signal.addEventListener('abort', onAbort, { once: true });
    }

    const channel = new Channel<RelayStreamEvent>();
    channel.onmessage = (msg) => {
      if (msg.type === 'status') {
        if (settled) return;
        settled = true;
        // Response() throws if a body is passed with these status codes.
        const bodyless = msg.status === 204 || msg.status === 205 || msg.status === 304;
        resolve(new Response(bodyless ? null : stream, { status: msg.status, headers: msg.headers }));
      } else if (msg.type === 'chunk') {
        if (!done) { try { controller?.enqueue(base64ToBytes(msg.data)); } catch { /* consumer gone */ } }
      } else if (msg.type === 'end') {
        if (!done) { done = true; try { controller?.close(); } catch { /* already closed */ } }
      } else if (msg.type === 'error') {
        fail(new Error(msg.message));
      }
    };

    invoke('http_relay_stream', {
      url,
      method: (init?.method || 'GET').toUpperCase(),
      headers,
      body: init?.body != null ? String(init.body) : null,
      channel,
    }).catch((err) => fail(err instanceof Error ? err : new Error(String(err))));
  });
};
