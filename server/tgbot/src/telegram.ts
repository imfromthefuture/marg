// Minimal Telegram Bot API client and per-chat send queue. The bot token only lives in the
// request URL; it is scrubbed from every error text so it can never reach the logs.

export type TgResponse = {
    ok: boolean;
    result?: any;
    error_code?: number;
    description?: string;
    parameters?: { retry_after?: number; migrate_to_chat_id?: number };
};

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const mono = () => performance.now(); // monotonic: a wall-clock step must not break the rate limit

export class Telegram {
    private base: string;
    constructor(apiBase: string, private token: string) {
        this.base = `${apiBase.replace(/\/+$/, '')}/bot${token}/`;
    }

    scrub(s: unknown): string {
        let t = String((s as any)?.message ?? s);
        if (this.token) t = t.split(this.token).join('***');
        return t.slice(0, 300);
    }

    async call(method: string, params: Record<string, unknown> = {}, timeoutMs = 20_000): Promise<TgResponse> {
        try {
            const r = await fetch(this.base + method, {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify(params),
                signal: AbortSignal.timeout(timeoutMs),
            });
            const body = (await r.json().catch(() => null)) as TgResponse | null;
            if (body && typeof body.ok === 'boolean') return body;
            return { ok: false, error_code: r.status, description: `HTTP ${r.status}` };
        } catch (e) {
            return { ok: false, error_code: 0, description: this.scrub(e) };
        }
    }
}

// kind 'reply' = command answers: kept in a small separate queue per chat and only sent when no
// alert is waiting, so command spam can never push buy alerts / launch posts out.
export type Job = { method: string; params: Record<string, any>; fallback?: Job; kind?: 'alert' | 'reply' };

type Queue = { jobs: Job[]; replies: Job[]; running: Promise<void> | null };

// Errors meaning the bot can no longer post in that chat.
export function chatGone(r: TgResponse): boolean {
    if (r.error_code === 403) return true;
    return r.error_code === 400 && /chat not found|kicked|not a member|have no rights to send|CHAT_WRITE_FORBIDDEN|group chat was deactivated/i.test(r.description ?? '');
}

export class Sender {
    private queues = new Map<string, Queue>();
    // All times are mono() (monotonic ms).
    private globalNext = 0;            // earliest time the next send (any chat) may go out
    private pausedUntil = 0;           // set by a 429: the whole sender waits, not just one chat
    private lastGlobal = -Infinity;    // when the last send actually went out
    private lastSent = new Map<string, number>(); // outlives the queue so the gap holds

    constructor(
        private tg: Pick<Telegram, 'call'>,
        private opts: {
            gapMs: number;           // per chat
            globalGapMs: number;     // across all chats (Telegram allows ~30 msg/s)
            maxQueue: number;        // alerts per chat
            maxReplies?: number;     // command replies per chat (default 5)
            onGone: (chatId: string, r: TgResponse) => void;
            onMigrate: (from: string, to: string) => void;
            log: (s: string) => void;
        },
    ) {}

    send(chatId: string | number, job: Job) {
        const k = String(chatId);
        let q = this.queues.get(k);
        if (!q) this.queues.set(k, (q = { jobs: [], replies: [], running: null }));
        const [list, max] = job.kind === 'reply' ? [q.replies, this.opts.maxReplies ?? 5] : [q.jobs, this.opts.maxQueue];
        list.push(job);
        if (list.length > max) list.splice(0, list.length - max); // drop oldest of the same kind
        if (!q.running) q.running = this.drain(k, q).finally(() => { q!.running = null; });
    }

    // Resolves when every queue is empty (used by tests and shutdown).
    async flush() {
        for (;;) {
            const running = [...this.queues.values()].map((q) => q.running).filter(Boolean);
            if (!running.length) return;
            await Promise.all(running);
        }
    }

    private async drain(chatId: string, q: Queue) {
        for (;;) {
            const job = q.jobs.shift() ?? q.replies.shift();
            if (!job) break;
            await this.deliver(chatId, q, job);
        }
        this.queues.delete(chatId);
    }

    // Wait for the per-chat gap, then claim a global slot *before* sleeping, so concurrent chat
    // queues get distinct slots globalGapMs apart. A 429 pause set while we slept re-queues us.
    private async acquire(target: string) {
        const chatWait = (this.lastSent.get(target) ?? -Infinity) + this.opts.gapMs - mono();
        if (chatWait > 0) await sleep(chatWait);
        for (;;) {
            const now = mono();
            const slot = Math.max(this.globalNext, now, this.pausedUntil);
            this.globalNext = slot + this.opts.globalGapMs;
            if (slot > now) await sleep(slot - now);
            if (this.pausedUntil <= mono()) break;
        }
        this.lastSent.set(target, mono());
        if (this.lastSent.size > 5000) this.lastSent.clear();
    }

    private async deliver(chatId: string, q: Queue, job: Job) {
        let current: Job | undefined = job;
        let target = chatId;
        for (let attempt = 0; current && attempt < 6; attempt++) {
            await this.acquire(target);
            // A late timer for the previous slot must not squeeze this one: enforce the real gap
            // too. No await between this check, the stamp and the call, so it is atomic.
            for (let w; (w = this.lastGlobal + this.opts.globalGapMs - mono()) > 0;) await sleep(w);
            this.lastGlobal = mono();
            const r = await this.tg.call(current.method, { ...current.params, chat_id: target });
            if (r.ok) return;
            const retry = r.parameters?.retry_after;
            if (r.error_code === 429 && retry) {
                this.opts.log(`429 in ${target}: pausing all sends for ${retry}s`);
                this.pausedUntil = Math.max(this.pausedUntil, mono() + Math.min(retry, 300) * 1000);
                continue;
            }
            const migrated = r.parameters?.migrate_to_chat_id;
            if (migrated) {
                this.opts.onMigrate(target, String(migrated));
                target = String(migrated);
                continue;
            }
            if (chatGone(r)) {
                this.opts.log(`chat ${target} gone (${r.error_code} ${r.description})`);
                q.jobs.length = 0;
                q.replies.length = 0;
                this.opts.onGone(target, r);
                return;
            }
            if (r.error_code === 0 || (r.error_code ?? 0) >= 500) {
                await sleep(2000 * (attempt + 1)); // network / Telegram trouble: retry
                continue;
            }
            // Other 400s (e.g. Telegram could not fetch the photo): try the fallback, else drop.
            this.opts.log(`${current.method} to ${target} failed: ${r.error_code} ${r.description}`);
            current = current.fallback;
        }
    }
}
