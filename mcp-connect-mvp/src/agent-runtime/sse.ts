/**
 * Agent runtime — Server-Sent Events parser over a byte stream.
 * Handles CRLF, multi-line `data:` fields, comments, `[DONE]`, and UTF-8
 * sequences split across chunks (TextDecoder in stream mode).
 */

export interface SseEvent {
  event?: string;
  data: string;
  id?: string;
}

export async function* parseSse(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncGenerator<SseEvent> {
  if (!body) return;
  const reader = body.getReader();
  const decoder = new TextDecoder('utf-8');
  let buffer = '';
  let event: string | undefined;
  let id: string | undefined;
  let dataLines: string[] = [];

  const flush = (): SseEvent | null => {
    if (dataLines.length === 0 && !event) return null;
    const out: SseEvent = { data: dataLines.join('\n'), event, id };
    event = undefined; id = undefined; dataLines = [];
    return out;
  };

  const onAbort = () => { void reader.cancel().catch(() => { /* ignore */ }); };
  signal?.addEventListener('abort', onAbort, { once: true });
  try {
    while (true) {
      if (signal?.aborted) break;
      const { value, done } = await reader.read();
      if (done) break;
      buffer += decoder.decode(value, { stream: true });
      let idx: number;
      while ((idx = buffer.search(/\r?\n/)) !== -1) {
        const line = buffer.slice(0, idx);
        buffer = buffer.slice(idx + (buffer[idx] === '\r' ? 2 : 1));
        if (line === '') {
          const ev = flush();
          if (ev) yield ev;
          continue;
        }
        if (line.startsWith(':')) continue; // comment / keep-alive
        const colon = line.indexOf(':');
        const field = colon === -1 ? line : line.slice(0, colon);
        let value = colon === -1 ? '' : line.slice(colon + 1);
        if (value.startsWith(' ')) value = value.slice(1);
        if (field === 'data') dataLines.push(value);
        else if (field === 'event') event = value;
        else if (field === 'id') id = value;
        // 'retry' and unknown fields ignored
      }
    }
    buffer += decoder.decode();
    if (buffer.trim()) {
      // Trailing data without a final blank line.
      for (const line of buffer.split(/\r?\n/)) {
        if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
      }
    }
    const last = flush();
    if (last) yield last;
  } finally {
    signal?.removeEventListener('abort', onAbort);
    try { reader.releaseLock(); } catch { /* ignore */ }
  }
}

/** Iterate JSON payloads from an SSE body, stopping at `[DONE]`. */
export async function* parseSseJson<T = unknown>(
  body: ReadableStream<Uint8Array> | null,
  signal?: AbortSignal,
): AsyncGenerator<{ event?: string; json: T }> {
  for await (const ev of parseSse(body, signal)) {
    const d = ev.data.trim();
    if (!d) continue;
    if (d === '[DONE]') return;
    try {
      yield { event: ev.event, json: JSON.parse(d) as T };
    } catch {
      // Non-JSON payload (keep-alive text) — skip.
    }
  }
}
