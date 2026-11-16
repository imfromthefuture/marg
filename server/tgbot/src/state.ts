// Bot state: one small JSON file, written atomically (temp file + fsync + rename), so a crash
// mid-write leaves the previous version intact. No native modules needed.
import fs from 'node:fs';
import path from 'node:path';

export type ChatCfg = { token?: string; symbol?: string; min: number; emoji: string };

export type StateData = {
    v: 1;
    launchInit: boolean;          // false until the first /tokens read marked everything seen
    seenLaunches: string[];
    tradeCursor: number | null;   // newest processed trade utime; null = never read the feed
    tradeSeen: Record<string, number>; // hash -> utime, kept for a window behind the cursor
    updateOffset: number;
    chats: Record<string, ChatCfg>;
};

const empty = (): StateData => ({ v: 1, launchInit: false, seenLaunches: [], tradeCursor: null, tradeSeen: {}, updateOffset: 0, chats: {} });

export const DEFAULT_EMOJI = '🟢';

export class State {
    data: StateData;
    seen: Set<string>;
    private file: string;
    private written = ''; // last JSON on disk: save() skips the write when nothing changed
    writes = 0;

    constructor(dir: string) {
        fs.mkdirSync(dir, { recursive: true });
        this.file = path.join(dir, 'state.json');
        let d = empty();
        try {
            const raw = JSON.parse(fs.readFileSync(this.file, 'utf8'));
            if (raw && raw.v === 1) d = { ...d, ...raw };
        } catch (e: any) {
            if (e?.code !== 'ENOENT') {
                // Never silently start fresh over a corrupt file (that would re-post everything):
                // keep it aside and refuse to run.
                throw new Error(`state file ${this.file} unreadable: ${String(e?.message ?? e).slice(0, 200)}`);
            }
        }
        this.data = d;
        try { this.written = JSON.stringify(d); } catch { /* ignore */ }
        this.seen = new Set(d.seenLaunches);
    }

    chat(id: string | number): ChatCfg {
        const k = String(id);
        return (this.data.chats[k] ??= { min: 0, emoji: DEFAULT_EMOJI });
    }

    // Returns true when the file was actually written.
    save(): boolean {
        this.data.seenLaunches = [...this.seen];
        const json = JSON.stringify(this.data);
        if (json === this.written) return false;
        const tmp = `${this.file}.${process.pid}.tmp`;
        const fd = fs.openSync(tmp, 'w', 0o600);
        try {
            fs.writeSync(fd, json);
            fs.fsyncSync(fd);
        } finally {
            fs.closeSync(fd);
        }
        fs.renameSync(tmp, this.file);
        this.written = json;
        this.writes++;
        return true;
    }
}
