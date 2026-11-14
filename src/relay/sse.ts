export interface SSEEvent {
  event?: string;
  data: string;
}

/** 流式空闲超时：连续 idleMs 毫秒没有任何字节才抛——健康生成每秒都在吐字，永不触发。 */
export class UpstreamIdleTimeoutError extends Error {
  constructor(public idleMs: number) {
    super(`Upstream sent no data for ${Math.round(idleMs / 1000)}s; connection considered dead`);
    this.name = 'UpstreamIdleTimeoutError';
  }
}

async function readWithIdle<T extends ReadableStreamDefaultReader<Uint8Array>>(
  reader: T,
  idleMs: number | undefined,
): Promise<{ done: boolean; value?: Uint8Array }> {
  if (!idleMs) return reader.read();
  return await new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(new UpstreamIdleTimeoutError(idleMs)), idleMs);
    reader.read().then(
      (r) => { clearTimeout(timer); resolve(r); },
      (e) => { clearTimeout(timer); reject(e); },
    );
  });
}

/** Splits a byte stream into SSE events without buffering the whole response.
 *  opts.idleMs：流式空闲超时（毫秒）。只盯"有没有动静"，不设总时长上限——
 *  健康的长流跑多久都行（2026-11-13 废除 120s 一刀切）。空闲触发时取消上游流。 */
export async function* readSSE(body: ReadableStream<Uint8Array>, opts?: { idleMs?: number }): AsyncGenerator<SSEEvent> {
  const reader = body.getReader();
  const decoder = new TextDecoder();
  let buf = '';
  try {
    while (true) {
      const { done, value } = await readWithIdle(reader, opts?.idleMs);
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
    // 空闲超时抛出时取消上游连接，别让死连接挂着；正常读完 cancel 也无害。
    if (opts?.idleMs) await reader.cancel().catch(() => {});
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
