export interface SSEEvent {
  event?: string;
  data: string;
}

/**
 * Incremental Server-Sent-Events parser. Feed arbitrary byte chunks (which may
 * split lines or events); it emits completed events. Comment lines (`: ping`
 * heartbeats) are ignored. Used only for metering — the raw bytes are forwarded
 * to the client untouched, so a parser bug can never corrupt the client stream.
 */
export class SSEParser {
  private buffer = '';
  private currentEvent: string | undefined = undefined;
  private dataLines: string[] = [];

  push(chunk: string): SSEEvent[] {
    this.buffer += chunk;
    const out: SSEEvent[] = [];
    let idx: number;
    while ((idx = this.buffer.indexOf('\n')) !== -1) {
      const raw = this.buffer.slice(0, idx);
      this.buffer = this.buffer.slice(idx + 1);
      const line = raw.endsWith('\r') ? raw.slice(0, -1) : raw;

      if (line === '') {
        if (this.dataLines.length > 0) {
          out.push({ event: this.currentEvent, data: this.dataLines.join('\n') });
        }
        this.currentEvent = undefined;
        this.dataLines = [];
        continue;
      }
      if (line.startsWith(':')) continue; // heartbeat / comment
      if (line.startsWith('event:')) {
        this.currentEvent = line.slice('event:'.length).trim();
      } else if (line.startsWith('data:')) {
        this.dataLines.push(line.slice('data:'.length).replace(/^ /, ''));
      }
    }
    return out;
  }
}
