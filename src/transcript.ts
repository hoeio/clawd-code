// The ONLY place that knows the transcript JSONL format (not an official contract).
// Read-only tail: returns Claude's own text blocks appended since the last call.
import fs from 'node:fs';

export class TranscriptTail {
  private offset = 0;
  private rest: Buffer = Buffer.alloc(0); // incomplete last line, kept as bytes so UTF-8 never splits
  readonly path: string;
  constructor(path: string) {
    this.path = path;
    // Start at the end: we only care about what Claude says from now on.
    try { this.offset = fs.statSync(path).size; } catch {}
  }

  readNewTexts(): string[] {
    let buf: Buffer;
    try {
      const fd = fs.openSync(this.path, 'r');
      try {
        const size = fs.fstatSync(fd).size;
        if (size < this.offset) this.offset = 0; // file replaced
        const fresh = Buffer.alloc(size - this.offset);
        fs.readSync(fd, fresh, 0, fresh.length, this.offset);
        this.offset = size;
        buf = Buffer.concat([this.rest, fresh]);
      } finally { fs.closeSync(fd); }
    } catch { return []; }
    const end = buf.lastIndexOf(0x0a) + 1;
    this.rest = buf.subarray(end);
    return buf.subarray(0, end).toString('utf8').split('\n').flatMap(assistantTexts);
  }
}

export function assistantTexts(line: string): string[] {
  try {
    const e = JSON.parse(line);
    if (e.type !== 'assistant' || e.isSidechain || !Array.isArray(e.message?.content)) return [];
    return e.message.content
      .filter((b: any) => b.type === 'text' && typeof b.text === 'string' && b.text.trim())
      .map((b: any) => b.text.trim());
  } catch { return []; }
}
