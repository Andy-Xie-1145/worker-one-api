export interface SSEEvent {
  event?: string;
  data: string;
}

/** Splits a byte stream into SSE events without buffering the whole response. */
export async function* readSSE(body: ReadableStream<Uint8Array>): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      buf += decoder.decode(value, { stream: true });
      let idx: number;
      // Events are separated by a blank line; handle both \n\n and \r\n\r\n.
      while ((idx = buf.search(/\r?\n\r?\n/)) !== -1) {
        const raw = buf.slice(0, idx);
        buf = buf.slice(idx + buf.slice(idx).match(/^\r?\n\r?\n/)![0].length);
        const ev = parseEvent(raw);
        if (ev) yield ev;
      }
    }
    const tail = parseEvent(buf);
    if (tail) yield tail;
  } finally {
    reader.releaseLock();
  }
}

function parseEvent(raw: string): SSEEvent | null {
  if (!raw.trim()) return null;
  let event: string | undefined;
  const dataLines: string[] = [];
  for (const line of raw.split(/\r?\n/)) {
    if (line.startsWith(':')) continue;
    if (line.startsWith('event:')) event = line.slice(6).trim();
    else if (line.startsWith('data:')) dataLines.push(line.slice(5).replace(/^ /, ''));
  }
  if (!dataLines.length && !event) return null;
  return { event, data: dataLines.join('\n') };
}

export function sseChunk(payload: unknown): string {
  return `data: ${typeof payload === 'string' ? payload : JSON.stringify(payload)}\n\n`;
}

export const SSE_DONE = 'data: [DONE]\n\n';

export const SSE_HEADERS = {
  'Content-Type': 'text/event-stream; charset=utf-8',
  'Cache-Control': 'no-cache',
  Connection: 'keep-alive',
  'X-Accel-Buffering': 'no',
};

/** Rough fallback when an upstream omits usage from its stream. */
export function estimateTokens(text: string): number {
  if (!text) return 0;
  // ~4 chars per token for latin text, ~1.5 for CJK.
  const cjk = (text.match(/[一-鿿぀-ヿ가-힯]/g) ?? []).length;
  return Math.ceil(cjk / 1.5 + (text.length - cjk) / 4);
}
