// MARG Telegram bot: launch feed for one channel + buy alerts for community groups.
// Data comes from the MARG indexer API; all of it is treated as untrusted (see format.ts).
import { buyMessage, cap, fromNano, HELP, httpsImage, isAddress, LaunchInfo, launchMessage, normalizeAddress, tokenButtons, tokText, validEmoji } from './format';
import { DEFAULT_EMOJI, State } from './state';
import { Job, Sender, Telegram, TgResponse } from './telegram';

export type Config = {
    botToken: string;
    tgApi: string;               // https://api.telegram.org
    launchChat: string | null;
    indexerUrl: string;          // .../api/idx
    siteUrl: string;             // https://marg.lol
    stateDir: string;
    toncenterUrl: string | null; // .../api/v2 (null = skip launch details)
    toncenterKey: string | null;
    coingeckoUrl: string;
    perChatGapMs: number;
    globalGapMs: number;
    pollTimeoutSec: number;
    launchMaxAgeSec: number;     // never announce launches older than this (backfill after an indexer reset)
    log: (s: string) => void;
    exit?: (code: number) => void; // default process.exit (tests inject a stub)
};

const ADDR_IN_TEXT = /(?:^|\/token\/)([A-Za-z0-9_-]{48}|-?\d{1,3}:[0-9a-fA-F]{64})(?:[/?#\s]|$)/;
const TRADE_WINDOW = 900;      // re-check trades this far behind the cursor (indexer lag)
const SEEN_MAX = 20_000;       // hard cap on remembered trade hashes
export const MAX_CHATS = 5000; // configured chats kept in state.json
const REPLY_EVERY_MS = 60_000; // /help, /status and "use this in a group" at most once a minute per chat
const ADMIN_TTL_MS = 60_000;   // getChatMember cache
const now = () => Math.floor(Date.now() / 1000);

export function parseTokenArg(arg: string): string | null {
    const s = arg.trim().split(/\s+/)[0] ?? '';
    if (s.length > 200) return null;
    const m = s.match(ADDR_IN_TEXT);
    return m ? normalizeAddress(m[1]) : null; // raw / UQ… / testnet forms -> the EQ… form the indexer keys by
}

// Delay before retrying after n consecutive failures: 1 s, 2 s, 4 s, … capped at 60 s.
export const backoffMs = (n: number) => Math.min(60_000, 1000 * 2 ** Math.max(0, Math.min(n - 1, 16)));

export class Bot {
    state: State;
    tg: Telegram;
    sender: Sender;
    username = '';
    private usd: { v: number | null; at: number } = { v: null, at: 0 };
    private stopped = false;
    private updFails = 0;
    private lastReply = new Map<string, number>();                  // chat:cmd -> ms
    private adminCache = new Map<string, { ok: boolean; at: number }>(); // chat:user -> status

    constructor(private cfg: Config) {
        this.state = new State(cfg.stateDir);
        this.tg = new Telegram(cfg.tgApi, cfg.botToken);
        this.sender = new Sender(this.tg, {
            gapMs: cfg.perChatGapMs,
            globalGapMs: cfg.globalGapMs,
            maxQueue: 30,
            log: cfg.log,
            onGone: (chat) => this.untrackGone(chat),
            onMigrate: (from, to) => this.migrate(from, to),
        });
    }

    // ---------- data sources ----------

    private async getJson(url: string, init?: RequestInit): Promise<any> {
        const r = await fetch(url, { ...init, signal: AbortSignal.timeout(10_000) });
        if (r.status === 404) return null;
        if (!r.ok) throw new Error(`HTTP ${r.status} from ${new URL(url).pathname}`);
        return r.json();
    }
    private idx(path: string) {
        return this.getJson(this.cfg.indexerUrl.replace(/\/+$/, '') + path);
    }

    async usdPrice(): Promise<number | null> {
        if (Date.now() - this.usd.at < 120_000) return this.usd.v;
        try {
            const j = await this.getJson(`${this.cfg.coingeckoUrl}?ids=the-open-network&vs_currencies=usd`);
            const v = Number(j?.['the-open-network']?.usd);
            this.usd = { v: Number.isFinite(v) && v > 0 ? v : this.usd.v, at: Date.now() };
        } catch (e: any) {
            this.usd.at = Date.now() - 90_000; // retry in ~30 s, keep the last good value
            this.cfg.log(`usd price: ${String(e?.message ?? e).slice(0, 120)}`);
        }
        return this.usd.v;
    }

    // get_launch_info by position; older masters stop at createdAt (no vault fields).
    async launchInfo(master: string): Promise<LaunchInfo | null> {
        if (!this.cfg.toncenterUrl) return null;
        try {
            const headers: Record<string, string> = { 'Content-Type': 'application/json' };
            if (this.cfg.toncenterKey) headers['X-API-Key'] = this.cfg.toncenterKey;
            const j = await this.getJson(`${this.cfg.toncenterUrl.replace(/\/+$/, '')}/runGetMethod`, {
                method: 'POST', headers, body: JSON.stringify({ address: master, method: 'get_launch_info', stack: [] }),
            });
            const stack = j?.result?.stack;
            if (!j?.ok || j.result.exit_code !== 0 || !Array.isArray(stack) || stack.length < 16) return null;
            const num = (i: number) => {
                const e = stack[i];
                if (!Array.isArray(e) || e[0] !== 'num' || typeof e[1] !== 'string' || !/^-?0x[0-9a-f]{1,80}$/i.test(e[1])) return NaN;
                const neg = e[1].startsWith('-');
                const v = Number(BigInt(neg ? e[1].slice(1) : e[1]));
                return neg ? -v : v;
            };
            const info: LaunchInfo = {
                launchFeePips: num(4), launchDuration: num(5), buyTaxBps: num(8), sellTaxBps: num(9),
                rewardsBps: num(11), walletBps: num(12), buybackBps: num(13),
            };
            if (stack.length >= 19) Object.assign(info, { vaultBps: num(16), vaultLock: num(17), vaultVest: num(18) });
            const ok = Object.values(info).every((v) => Number.isFinite(v) && v >= 0 && v < 2 ** 40);
            return ok ? info : null;
        } catch (e: any) {
            this.cfg.log(`launch info ${master}: ${String(e?.message ?? e).slice(0, 120)}`);
            return null;
        }
    }

    // ---------- launch feed ----------

    async pollLaunches() {
        const list = await this.idx('/tokens?kind=dex');
        if (!Array.isArray(list)) return;
        const st = this.state;
        if (!st.data.launchInit) {
            for (const t of list) if (typeof t?.address === 'string') st.seen.add(t.address);
            st.data.launchInit = true;
            st.save();
            this.cfg.log(`launch feed: first run, marked ${st.seen.size} existing tokens seen`);
            return;
        }
        const fresh = list
            .filter((t) => t && t.kind === 'dex' && !t.placeholder && isAddress(t.address) && !st.seen.has(t.address))
            .sort((a, b) => (Number(a.createdAt) || 0) - (Number(b.createdAt) || 0));
        if (!fresh.length) return;
        for (const t of fresh) st.seen.add(t.address);
        st.save(); // before posting: a crash loses a post rather than duplicating it
        if (!this.cfg.launchChat) return;
        let posted = 0;
        for (const t of fresh) {
            if (now() - (Number(t.createdAt) || 0) > this.cfg.launchMaxAgeSec) continue;
            if (posted++ >= 5) break; // flood guard
            const [usd, info] = await Promise.all([this.usdPrice(), this.launchInfo(t.address)]);
            const text = launchMessage(t, usd, info);
            const reply_markup = tokenButtons(this.cfg.siteUrl, t.address);
            const plain: Job = { method: 'sendMessage', params: { text, parse_mode: 'HTML', reply_markup, link_preview_options: { is_disabled: true } } };
            const img = httpsImage(t.image);
            this.cfg.log(`launch: ${t.address}`);
            this.sender.send(this.cfg.launchChat, img
                ? { method: 'sendPhoto', params: { photo: img, caption: text, parse_mode: 'HTML', reply_markup }, fallback: plain }
                : plain);
        }
    }

    // ---------- buy alerts ----------

    async pollTrades() {
        const trades = await this.idx('/trades?limit=100');
        if (!Array.isArray(trades)) return;
        const st = this.state.data;
        const valid = trades.filter((t) => t && typeof t.hash === 'string' && t.hash.length <= 100 && Number.isSafeInteger(t.utime));
        if (st.tradeCursor === null) {
            st.tradeCursor = valid.reduce((m, t) => Math.max(m, t.utime), now());
            for (const t of valid) st.tradeSeen[t.hash] = t.utime;
            this.pruneSeen(st.tradeCursor!);
            this.state.save();
            this.cfg.log(`buy feed: first run, skipped ${valid.length} existing trades`);
            return;
        }
        let cursor = st.tradeCursor;
        const floor = cursor - TRADE_WINDOW;
        const fresh = valid
            .filter((t) => t.utime >= floor && !(t.hash in st.tradeSeen))
            .reverse() // the feed is newest first
            .sort((a, b) => a.utime - b.utime);
        if (!fresh.length) return;
        for (const t of fresh) {
            st.tradeSeen[t.hash] = t.utime;
            if (t.utime > cursor) cursor = t.utime;
        }
        st.tradeCursor = cursor;
        this.pruneSeen(cursor);
        this.state.save(); // before posting, as above

        const buys = fresh.filter((t) => t.isBuy === true && typeof t.token === 'string');
        if (!buys.length) return;
        const chats = Object.entries(st.chats).filter(([, c]) => c.token);
        if (!chats.length) return;
        const usd = await this.usdPrice();
        for (const t of buys) {
            const gram = fromNano(t.ton);
            for (const [chatId, c] of chats) {
                if (c.token !== t.token || gram < c.min) continue;
                this.sender.send(chatId, {
                    method: 'sendMessage',
                    params: { text: buyMessage(t, c.emoji, usd), parse_mode: 'HTML', reply_markup: tokenButtons(this.cfg.siteUrl, t.token), link_preview_options: { is_disabled: true } },
                });
            }
        }
    }

    // Only hashes inside the re-check window can ever be consulted again.
    private pruneSeen(cursor: number) {
        const seen = this.state.data.tradeSeen;
        const keep = cursor - TRADE_WINDOW;
        for (const [h, u] of Object.entries(seen)) if (!(u >= keep)) delete seen[h];
        const ents = Object.entries(seen);
        if (ents.length > SEEN_MAX) {
            ents.sort((x, y) => x[1] - y[1]);
            for (const [h] of ents.slice(0, ents.length - SEEN_MAX)) delete seen[h];
        }
    }

    private untrackGone(chatId: string) {
        if (chatId === this.cfg.launchChat) return;
        if (this.state.data.chats[chatId]) {
            delete this.state.data.chats[chatId];
            this.state.save();
            this.cfg.log(`untracked ${chatId} (bot removed or muted)`);
        }
    }
    private migrate(from: string, to: string) {
        const c = this.state.data.chats[from];
        if (!c) return;
        this.state.data.chats[to] = c;
        delete this.state.data.chats[from];
        this.state.save();
    }

    // ---------- commands ----------

    private reply(chatId: number | string, text: string) {
        this.sender.send(chatId, { kind: 'reply', method: 'sendMessage', params: { text, parse_mode: 'HTML', link_preview_options: { is_disabled: true } } });
    }

    // Reply at most once per REPLY_EVERY_MS for this chat+key; silently drop otherwise.
    private replyLimited(chatId: number | string, key: string, text: string) {
        const k = `${chatId}:${key}`;
        const t = Date.now();
        if (t - (this.lastReply.get(k) ?? -Infinity) < REPLY_EVERY_MS) return;
        if (this.lastReply.size > 10_000) {
            for (const [x, at] of this.lastReply) if (t - at >= REPLY_EVERY_MS) this.lastReply.delete(x);
        }
        this.lastReply.set(k, t);
        this.reply(chatId, text);
    }

    private async isAdmin(msg: any): Promise<boolean> {
        if (msg.sender_chat && msg.sender_chat.id === msg.chat.id) return true; // anonymous group admin
        if (!msg.from || typeof msg.from.id !== 'number') return false;
        const k = `${msg.chat.id}:${msg.from.id}`;
        const t = Date.now();
        const hit = this.adminCache.get(k);
        if (hit && t - hit.at < ADMIN_TTL_MS) return hit.ok;
        const r: TgResponse = await this.tg.call('getChatMember', { chat_id: msg.chat.id, user_id: msg.from.id });
        const ok = r.ok && (r.result?.status === 'creator' || r.result?.status === 'administrator');
        if (r.ok) { // never cache a failed lookup
            if (this.adminCache.size > 10_000) {
                for (const [x, v] of this.adminCache) if (t - v.at >= ADMIN_TTL_MS) this.adminCache.delete(x);
                if (this.adminCache.size > 10_000) this.adminCache.clear();
            }
            this.adminCache.set(k, { ok, at: t });
        }
        return ok;
    }

    async handleUpdate(u: any) {
        const mcm = u?.my_chat_member;
        if (mcm?.chat && ['left', 'kicked'].includes(mcm.new_chat_member?.status)) {
            this.untrackGone(String(mcm.chat.id));
            return;
        }
        const msg = u?.message;
        if (!msg?.chat || typeof msg.chat.id !== 'number') return;
        if (msg.migrate_to_chat_id) return this.migrate(String(msg.chat.id), String(msg.migrate_to_chat_id));
        if (typeof msg.text !== 'string' || !msg.text.startsWith('/')) return;
        const m = msg.text.match(/^\/([A-Za-z_]{1,32})(?:@([A-Za-z0-9_]{1,64}))?(?:\s+([\s\S]*))?$/);
        if (!m) return;
        if (m[2] && this.username && m[2].toLowerCase() !== this.username.toLowerCase()) return; // another bot's command
        const cmd = m[1].toLowerCase();
        const arg = (m[3] ?? '').trim();
        const chatId = msg.chat.id;
        const group = msg.chat.type === 'group' || msg.chat.type === 'supergroup';

        if (cmd === 'start' || cmd === 'help') return this.replyLimited(chatId, 'help', HELP);
        if (!['track', 'untrack', 'min', 'emoji', 'status'].includes(cmd)) return;
        if (!group) return this.replyLimited(chatId, 'group', 'Add me to your group and use this command there.');

        const key = String(chatId);
        const cur = this.state.data.chats[key];
        if (cmd === 'status') {
            const c = cur ?? { min: 0, emoji: DEFAULT_EMOJI };
            return this.replyLimited(chatId, 'status', c.token
                ? `Tracking ${tokText(c.symbol, 16)} (<code>${c.token}</code>)\nMin buy: ${c.min} Gram\nEmoji: ${c.emoji}`
                : `Not tracking a token. Use /track &lt;token address&gt;.\nMin buy: ${c.min} Gram\nEmoji: ${c.emoji}`);
        }
        // Non-admins get no reply at all: answering them would let anyone flood the group.
        if (!(await this.isAdmin(msg))) return;
        if (!cur && cmd !== 'untrack' && Object.keys(this.state.data.chats).length >= MAX_CHATS) {
            this.cfg.log(`chat limit (${MAX_CHATS}) reached, refusing ${key}`);
            return this.reply(chatId, 'The bot is at capacity right now, sorry. Try again later.');
        }

        if (cmd === 'track') {
            const addr = parseTokenArg(arg);
            if (!addr) return this.reply(chatId, 'Usage: /track &lt;token address or https://marg.lol/token/… link&gt;');
            let t: any;
            try {
                t = await this.idx(`/token/${encodeURIComponent(addr)}`);
            } catch (e: any) {
                this.cfg.log(`track lookup: ${String(e?.message ?? e).slice(0, 120)}`);
                return this.reply(chatId, 'The MARG indexer is not reachable right now, try again in a minute.');
            }
            if (!t || t.kind !== 'dex' || !isAddress(t.address)) return this.reply(chatId, 'That is not a MARG token.');
            const c = this.state.chat(key);
            c.token = t.address;
            c.symbol = cap(t.symbol, 16);
            this.state.save();
            return this.reply(chatId, `Now posting buys of ${tokText(t.symbol, 16)} (${tokText(t.name, 64)}) here. Min buy: ${c.min} Gram.`);
        }
        if (cmd === 'untrack') {
            if (cur) {
                delete cur.token;
                delete cur.symbol;
                if (cur.min === 0 && cur.emoji === DEFAULT_EMOJI) delete this.state.data.chats[key]; // nothing left to keep
                this.state.save();
            }
            return this.reply(chatId, 'Stopped posting buys.');
        }
        if (cmd === 'min') {
            const v = Number(arg.replace(',', '.'));
            if (!arg || !Number.isFinite(v) || v < 0 || v > 1_000_000) return this.reply(chatId, 'Usage: /min &lt;gram&gt;, e.g. /min 5');
            this.state.chat(key).min = Math.round(v * 1e4) / 1e4;
            this.state.save();
            return this.reply(chatId, `Minimum buy set to ${this.state.chat(key).min} Gram.`);
        }
        if (cmd === 'emoji') {
            if (!validEmoji(arg)) return this.reply(chatId, 'Usage: /emoji 🐸 (one to three emoji)');
            this.state.chat(key).emoji = arg;
            this.state.save();
            return this.reply(chatId, `Buy emoji set to ${arg}`);
        }
    }

    async pollUpdatesOnce(timeoutSec = this.cfg.pollTimeoutSec) {
        const r = await this.tg.call('getUpdates', {
            offset: this.state.data.updateOffset, timeout: timeoutSec, allowed_updates: ['message', 'my_chat_member'],
        }, (timeoutSec + 15) * 1000);
        if (!r.ok) {
            if (r.error_code === 401) return this.fatal('Telegram rejected the bot token (401 Unauthorized): it was revoked or is wrong. Set a new TG_BOT_TOKEN in the environment file; exiting.');
            this.updFails++;
            const wait = r.parameters?.retry_after ? r.parameters.retry_after * 1000 : backoffMs(this.updFails);
            this.cfg.log(`getUpdates: ${r.error_code} ${this.tg.scrub(r.description)} (retry in ${Math.round(Math.min(wait, 60_000) / 1000)}s)`);
            await new Promise((res) => setTimeout(res, Math.min(wait, 60_000)));
            return;
        }
        this.updFails = 0;
        for (const u of Array.isArray(r.result) ? r.result : []) {
            if (!Number.isSafeInteger(u?.update_id)) continue;
            this.state.data.updateOffset = u.update_id + 1;
            this.state.save(); // before handling: a poison update is never retried forever
            try {
                await this.handleUpdate(u);
            } catch (e: any) {
                this.cfg.log(`update ${u.update_id}: ${this.tg.scrub(e)}`);
            }
        }
    }

    // ---------- main ----------

    // Unrecoverable: log (the token is never part of the message) and exit 1, so systemd's
    // StartLimitBurst eventually stops restarting instead of hammering Telegram forever.
    private fatal(why: string) {
        this.cfg.log(why);
        this.stop();
        (this.cfg.exit ?? ((c: number) => process.exit(c)))(1);
    }

    async init() {
        const me = await this.tg.call('getMe');
        if (!me.ok && me.error_code === 401) return this.fatal('Telegram rejected the bot token (401 Unauthorized) at startup; exiting.');
        if (!me.ok) throw new Error(`getMe failed: ${me.error_code} ${this.tg.scrub(me.description)}`);
        this.username = String(me.result?.username ?? '');
        this.cfg.log(`running as @${this.username}; launch chat ${this.cfg.launchChat ?? '(none)'}; ${Object.keys(this.state.data.chats).length} chats`);
    }

    private loop(name: string, everyMs: number, fn: () => Promise<void>) {
        (async () => {
            let fails = 0;
            while (!this.stopped) {
                const t0 = Date.now();
                try {
                    await fn();
                    fails = 0;
                } catch (e: any) {
                    fails++;
                    this.cfg.log(`${name}: ${this.tg.scrub(e)}`);
                }
                const wait = Math.max(everyMs - (Date.now() - t0), fails ? backoffMs(fails) : 0);
                if (wait > 0) await new Promise((r) => setTimeout(r, wait));
            }
        })();
    }

    async start() {
        await this.init();
        if (this.stopped) return;
        this.loop('launches', 15_000, () => this.pollLaunches());
        this.loop('trades', 5_000, () => this.pollTrades());
        this.loop('updates', 0, () => this.pollUpdatesOnce());
    }

    stop() {
        this.stopped = true;
    }
}
