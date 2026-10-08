// Handoff gate (optional, off by default): a code-change request from chat, approved by the user,
// is queued for hooks/deliver.sh to hand to Claude Code exactly once (next prompt or next stop).
import crypto from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';

export interface HandoffOpts {
  dir: string; // ~/.clawd-companion/handoff
  now?: () => number;
  maxQueued?: number;
  ttlMs?: number; // a queued item older than this is dropped, never delivered late
  draftTtlMs?: number;
  onDelivered?: (instruction: string) => void;
}
export type ApproveResult = 'queued' | 'unknown' | 'duplicate' | 'full';

interface Queued { sessionId: string; instruction: string; at: number; path: string }

export class Handoff {
  private o: Required<Omit<HandoffOpts, 'onDelivered'>> & Pick<HandoffOpts, 'onDelivered'>;
  private drafts = new Map<string, { instruction: string; sessionId: string; at: number }>();
  private queued = new Map<string, Queued>();

  constructor(o: HandoffOpts) {
    this.o = { now: Date.now, maxQueued: 3, ttlMs: 30 * 60_000, draftTtlMs: 10 * 60_000, ...o };
    // Items left over from a previous daemon run are stale by definition.
    fs.rmSync(path.join(o.dir, 'queue'), { recursive: true, force: true });
  }

  /** Clawd proposes; nothing is queued until the user approves. */
  draft(instruction: string, sessionId: string): string {
    const id = crypto.randomBytes(8).toString('hex');
    this.drafts.set(id, { instruction, sessionId: sessionId.replace(/[^A-Za-z0-9-]/g, ''), at: this.o.now() });
    return id;
  }

  approve(id: string): ApproveResult {
    const d = this.drafts.get(id);
    if (!d || !d.sessionId || this.o.now() - d.at > this.o.draftTtlMs) return 'unknown';
    if ([...this.queued.values()].some(q => q.sessionId === d.sessionId && q.instruction === d.instruction)) return 'duplicate';
    if (this.queued.size >= this.o.maxQueued) return 'full';
    this.drafts.delete(id);

    // Pre-render the exact hook output, then publish atomically (rename) so deliver.sh never sees half an item.
    const name = `${this.o.now().toString().padStart(15, '0')}-${id}`; // sortable: FIFO by glob order
    const dest = path.join(this.o.dir, 'queue', d.sessionId, name);
    const tmp = path.join(this.o.dir, 'tmp', name);
    fs.mkdirSync(tmp, { recursive: true });
    fs.writeFileSync(path.join(tmp, 'UserPromptSubmit.json'), JSON.stringify({
      hookSpecificOutput: {
        hookEventName: 'UserPromptSubmit',
        additionalContext: `Instruction the user approved in the Clawd companion window (treat it as part of this request): ${d.instruction}`,
      },
    }));
    fs.writeFileSync(path.join(tmp, 'Stop.json'), JSON.stringify({
      decision: 'block',
      reason: `The user approved a follow-up in the Clawd companion window. Do this next: ${d.instruction}`,
    }));
    fs.mkdirSync(path.dirname(dest), { recursive: true });
    fs.renameSync(tmp, dest);
    this.queued.set(id, { sessionId: d.sessionId, instruction: d.instruction, at: this.o.now(), path: dest });
    return 'queued';
  }

  /** Notices deliveries (deliver.sh removed the item) and drops expired items. */
  tick(): void {
    const now = this.o.now();
    for (const [id, q] of this.queued) {
      if (!fs.existsSync(q.path)) {
        this.queued.delete(id);
        this.o.onDelivered?.(q.instruction);
      } else if (now - q.at > this.o.ttlMs) {
        // Rename first: if deliver.sh claims it at the same moment, exactly one of us wins.
        const trash = path.join(this.o.dir, 'trash', path.basename(q.path));
        try { fs.mkdirSync(path.dirname(trash), { recursive: true }); fs.renameSync(q.path, trash); fs.rmSync(trash, { recursive: true, force: true }); } catch {}
        this.queued.delete(id);
      }
    }
    for (const [id, d] of this.drafts) if (now - d.at > this.o.draftTtlMs) this.drafts.delete(id);
  }

  get queuedCount() { return this.queued.size; }
}
