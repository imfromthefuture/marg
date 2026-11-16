// Local test: a fake Telegram Bot API, fake indexer, fake CoinGecko and fake toncenter on one
// loopback HTTP server. Never touches the real Telegram API. Run with `npm test`.
import assert from 'node:assert/strict';
import http from 'node:http';
import { AddressInfo } from 'node:net';
import path from 'node:path';
import { backoffMs, Bot, Config, MAX_CHATS, parseTokenArg } from '../src/bot';
import { buyMessage, esc, friendlyAddress, hashHex, launchMessage, normalizeAddress, validEmoji } from '../src/format';
import { Sender, TgResponse } from '../src/telegram';

const TOKEN = '123456:TEST_fake_token_aaaaaaaaaaaaaaaaaaaaaaaaaa';
const ADMIN = 1, MEMBER = 2;
const GROUP = -1001, GROUP2 = -1002;
const LAUNCH = '@marglaunches';
const a = (c: string) => friendlyAddress(0, Buffer.alloc(32, c.charCodeAt(0))); // valid checksummed EQ… address
const T1 = a('A'), T2 = a('B'), T3 = a('C'), CURVE = a('D'), TRADER = a('E');

// ---- fake world ----
const tokens: any[] = [];
let trades: any[] = []; // newest first, like the indexer
let updates: any[] = [];
const sent: { method: string; params: any }[] = [];
const forbidden = new Set<string>();
let rate429 = 0;
let updatesError = 0;      // HTTP status getUpdates answers with (0 = ok)
let getChatMemberCalls = 0;
const logs: string[] = [];

const tok = (address: string, extra: any = {}) => ({
    address, name: 'Tok', symbol: 'TOK', description: '', image: '', creator: TRADER, createdAt: Math.floor(Date.now() / 1000),
    price: 0.0000026, mcap: '2600000000000', volume24h: '0', kind: 'dex', pool: a('P'), factory: a('F'), placeholder: false, ...extra,
});
let hashN = 0;
const trade = (token: string, gram: number, isBuy = true, utime = Math.floor(Date.now() / 1000)) => ({
    hash: Buffer.alloc(32, ++hashN).toString('base64'), utime, isBuy, trader: TRADER,
    ton: String(Math.round(gram * 1e9)), tokens: String(Math.round(gram * 4e14)), price: 0.0000026, token, symbol: 'TOK', image: '',
});
const num = (n: number) => ['num', '0x' + n.toString(16)];
const cell = ['cell', { bytes: 'x' }];

const server = http.createServer((req, res) => {
    let body = '';
    req.on('data', (c) => (body += c));
    req.on('end', () => {
        const url = new URL(req.url!, 'http://x');
        const json = (status: number, v: unknown) => { res.writeHead(status, { 'Content-Type': 'application/json' }); res.end(JSON.stringify(v)); };
        const p = url.pathname;
        if (p.startsWith('/bot')) {
            assert.ok(p.startsWith(`/bot${TOKEN}/`), 'token in path');
            const method = p.split('/').pop()!;
            const params = body ? JSON.parse(body) : {};
            if (method === 'getMe') return json(200, { ok: true, result: { id: 9, is_bot: true, username: 'marglolbot' } });
            if (method === 'getUpdates' && updatesError) {
                const code = updatesError;
                if (code !== 401) updatesError = 0;
                return json(code, { ok: false, error_code: code, description: code === 401 ? 'Unauthorized' : 'Internal Server Error' });
            }
            if (method === 'getUpdates') {
                const out = updates.filter((u) => u.update_id >= (params.offset ?? 0));
                updates = [];
                return json(200, { ok: true, result: out });
            }
            if (method === 'getChatMember') getChatMemberCalls++;
            if (method === 'getChatMember') return json(200, { ok: true, result: { status: params.user_id === ADMIN ? 'administrator' : 'member' } });
            if (method === 'sendMessage' || method === 'sendPhoto') {
                if (forbidden.has(String(params.chat_id))) return json(403, { ok: false, error_code: 403, description: 'Forbidden: bot was kicked from the supergroup chat' });
                if (rate429 > 0) { rate429--; return json(429, { ok: false, error_code: 429, description: 'Too Many Requests', parameters: { retry_after: 1 } }); }
                sent.push({ method, params });
                return json(200, { ok: true, result: { message_id: sent.length } });
            }
            return json(404, { ok: false, error_code: 404, description: 'Not Found' });
        }
        if (p === '/api/idx/tokens') return json(200, tokens.filter((t) => !url.searchParams.get('kind') || t.kind === url.searchParams.get('kind')));
        if (p === '/api/idx/trades') return json(200, trades.slice(0, Number(url.searchParams.get('limit') ?? 30)));
        const m = p.match(/^\/api\/idx\/token\/([^/]+)$/);
        if (m) { const t = tokens.find((x) => x.address === decodeURIComponent(m[1])); return t ? json(200, t) : json(404, { error: 'unknown token' }); }
        if (p === '/cg') return json(200, { 'the-open-network': { usd: 2 } });
        if (p === '/tc/runGetMethod') {
            const stack = [cell, cell, cell, num(200), num(900000), num(15), num(1), cell, num(300), num(500), cell, num(3400), num(3300), num(3300), num(1e9), num(1), num(500), num(2592000), num(7776000)];
            return json(200, { ok: true, result: { exit_code: 0, stack } });
        }
        json(404, {});
    });
});

let base = '';
const cfg = (): Config => ({
    botToken: TOKEN, tgApi: base, launchChat: LAUNCH, indexerUrl: base + '/api/idx', siteUrl: 'https://marg.lol',
    stateDir: path.join(process.env.TGBOT_TEST_DIR ?? '/tmp/tgbot-test-' + process.pid, 'state'),
    toncenterUrl: base + '/tc', toncenterKey: null, coingeckoUrl: base + '/cg',
    perChatGapMs: 5, globalGapMs: 0, pollTimeoutSec: 0, launchMaxAgeSec: 3600, log: (s) => logs.push(s),
});
const msg = (id: number, from: number, chat: number, text: string) => ({ update_id: id, message: { message_id: id, from: { id: from }, chat: { id: chat, type: 'supergroup' }, text } });
const textOf = (s: { params: any }) => s.params.text ?? s.params.caption;

async function run(name: string, fn: () => Promise<void>) {
    try {
        await fn();
        console.log(`ok   ${name}`);
    } catch (e) {
        console.log(`FAIL ${name}`);
        throw e;
    }
}

async function main() {
    await new Promise<void>((r) => server.listen(0, '127.0.0.1', r));
    base = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;

    await run('helpers', async () => {
        assert.equal(parseTokenArg(T1), T1);
        assert.equal(parseTokenArg(`https://marg.lol/token/${T1}`), T1);
        assert.equal(parseTokenArg(`marg.lol/token/${T1}?ref=x`), T1);
        assert.equal(parseTokenArg('hello'), null);
        assert.equal(parseTokenArg(`https://evil.example/${T1}x`), null);
        assert.ok(validEmoji('🟢') && validEmoji('🐸') && validEmoji('🇺🇦') && validEmoji('🔥🔥'));
        assert.ok(!validEmoji('<b>') && !validEmoji('abc') && !validEmoji('🔥🔥🔥🔥') && !validEmoji(''));
        assert.equal(hashHex(Buffer.alloc(32, 255).toString('base64')), 'ff'.repeat(32));
        assert.equal(hashHex('not a hash'), null);
        assert.equal(esc('<b>x</b>&"'), '&lt;b&gt;x&lt;/b&gt;&amp;&quot;');
        assert.equal(backoffMs(1), 1000);
        assert.equal(backoffMs(2), 2000);
        assert.equal(backoffMs(4), 8000);
        assert.equal(backoffMs(7), 60_000);
        assert.equal(backoffMs(1000), 60_000);
    });

    await run('address normalization (vectors from @ton/core)', async () => {
        const EQ = 'EQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq8Uk';
        assert.equal(normalizeAddress('0:' + 'ab'.repeat(32)), EQ);
        assert.equal(normalizeAddress('0:' + 'AB'.repeat(32)), EQ);
        assert.equal(normalizeAddress(EQ), EQ);
        assert.equal(normalizeAddress('UQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq5jh'), EQ); // non-bounceable
        assert.equal(normalizeAddress('0QCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urqyNr'), EQ); // testnet
        assert.equal(normalizeAddress('-1:' + '3'.repeat(64)), 'Ef8zMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzMzM0vF');
        assert.equal(normalizeAddress('EQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq8Uj'), null); // bad checksum
        assert.equal(normalizeAddress('EQ' + 'A'.repeat(46)), null);
        assert.equal(normalizeAddress('999:' + 'ab'.repeat(32)), null);
        assert.equal(parseTokenArg('0:' + 'ab'.repeat(32)), EQ);
        assert.equal(parseTokenArg('https://marg.lol/token/UQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq5jh'), EQ);
    });

    await run('token text is never auto-linkable', async () => {
        const outsideCode = (h: string) => h.replace(/<code>[^<]*<\/code>/g, '');
        const buy = buyMessage({ ...trade(T1, 5), symbol: 't.me/scamxx' }, '🟢', 2);
        assert.ok(buy.includes('<code>t.me/scamxx</code>'), buy);
        assert.ok(!outsideCode(buy).includes('t.me'), buy);
        const launch = launchMessage(tok(T1, { name: '@fakesupport', symbol: '/claim', description: 'visit evil.example/x' }), 2, null);
        for (const bad of ['@fakesupport', '/claim', 'evil.example']) assert.ok(!outsideCode(launch).includes(bad), launch);
        assert.ok(!/<b>[^<]*<code>|<i>[^<]*<code>/.test(launch + buy), 'code never nested in b/i');
    });

    await run('global rate limit: 200 chats spaced >= 1/30 s', async () => {
        const at: number[] = [];
        const s = new Sender({ call: async () => { at.push(performance.now()); return { ok: true }; } }, {
            gapMs: 3000, globalGapMs: 40 /* production value */, maxQueue: 30, onGone: () => {}, onMigrate: () => {}, log: () => {},
        });
        for (let i = 0; i < 200; i++) s.send(-5000 - i, { method: 'sendMessage', params: { text: 'x' } });
        await s.flush();
        assert.equal(at.length, 200);
        for (let i = 1; i < at.length; i++) assert.ok(at[i] - at[i - 1] >= 1000 / 30, `gap ${(at[i] - at[i - 1]).toFixed(1)} ms at ${i}`);
        for (let i = 30; i < at.length; i++) assert.ok(at[i] - at[i - 30] >= 1000, `31 sends within ${at[i] - at[i - 30]} ms`);
        assert.ok((at[199] - at[0]) / 199 >= 1000 / 30, 'average spacing');
    });

    await run('429 pauses the whole sender', async () => {
        const at: Record<string, number[]> = {};
        let first = true;
        const s = new Sender({
            call: async (_m: string, p: any): Promise<TgResponse> => {
                (at[p.chat_id] ??= []).push(Date.now());
                if (first) { first = false; return { ok: false, error_code: 429, parameters: { retry_after: 1 } }; }
                return { ok: true };
            },
        }, { gapMs: 0, globalGapMs: 5, maxQueue: 30, onGone: () => {}, onMigrate: () => {}, log: () => {} });
        const t0 = Date.now();
        s.send('A', { method: 'sendMessage', params: {} });
        s.send('B', { method: 'sendMessage', params: {} });
        await s.flush();
        assert.equal(at.A.length, 2);
        assert.ok(at.B[0] - t0 >= 950, `B sent ${at.B[0] - t0} ms after A's 429`);
    });

    await run('command replies never evict alerts', async () => {
        const got: string[] = [];
        const s = new Sender({ call: async (_m: string, p: any) => { got.push(p.text); return { ok: true }; } }, {
            gapMs: 0, globalGapMs: 0, maxQueue: 30, onGone: () => {}, onMigrate: () => {}, log: () => {},
        });
        for (let i = 0; i < 100; i++) s.send(1, { kind: 'reply', method: 'sendMessage', params: { text: 'r' } });
        for (let i = 0; i < 30; i++) s.send(1, { method: 'sendMessage', params: { text: 'alert' + i } });
        await s.flush();
        const alerts = got.filter((t) => t.startsWith('alert'));
        assert.equal(alerts.length, 30);
        assert.ok(got.filter((t) => t === 'r').length <= 6);
        assert.ok(got.indexOf('alert29') < got.lastIndexOf('r'), 'alerts go before queued replies');
    });

    let bot = new Bot(cfg());
    await bot.init();
    tokens.push(tok(T1), tok(T3), tok(CURVE, { kind: 'curve' }));
    trades = [trade(T1, 50), trade(T1, 20)];

    await run('first run posts nothing', async () => {
        await bot.pollLaunches();
        await bot.pollTrades();
        await bot.sender.flush();
        assert.equal(sent.length, 0);
    });

    await run('new launch posts once, escaped, with details', async () => {
        tokens.unshift(tok(T2, { name: '<b>x</b>&', symbol: '<i>S', description: 'a <script>', image: 'https://marg.lol/u/a.png' }));
        tokens.unshift(tok(a('G'), { placeholder: true }));
        tokens.unshift(tok(a('H'), { name: 'NoImg', image: 'javascript:alert(1)' }));
        tokens.unshift(tok(a('I'), { name: 'Old', createdAt: 1_000 }));
        await bot.pollLaunches();
        await bot.pollLaunches();
        await bot.sender.flush();
        assert.equal(sent.length, 2, JSON.stringify(sent.map((s) => s.method)));
        const photo = sent.find((s) => s.method === 'sendPhoto')!;
        assert.equal(photo.params.chat_id, LAUNCH);
        assert.equal(photo.params.photo, 'https://marg.lol/u/a.png');
        const cap = photo.params.caption as string;
        assert.ok(cap.includes('&lt;b&gt;x&lt;/b&gt;&amp;'), cap);
        assert.ok(!cap.includes('<b>x</b>') && !cap.includes('<script>') && !cap.includes('<i>S'), cap);
        assert.ok(cap.includes('🚀') && cap.includes('2.6K Gram ($5.2K)'), cap);
        assert.ok(cap.includes('3% buy / 5% sell') && cap.includes('90% fee for the first 15s') && cap.includes('5% of supply, 30d lock, 90d vest'), cap);
        assert.deepEqual(photo.params.reply_markup.inline_keyboard[0].map((b: any) => b.url), [`https://marg.lol/token/${T2}`, `https://marg.lol/token/${T2}`]);
        const plain = sent.find((s) => s.method === 'sendMessage')!;
        assert.ok(plain.params.text.includes('NoImg') && !JSON.stringify(plain).includes('javascript'));
        sent.length = 0;
    });

    await run('/track by non-admin silently ignored (getChatMember cached), by admin stored', async () => {
        const calls0 = getChatMemberCalls;
        updates = [7, 8, 9, 10].map((id) => msg(id, MEMBER, GROUP, `/track ${T1}`));
        await bot.pollUpdatesOnce(0);
        await bot.sender.flush();
        assert.equal(bot.state.data.chats[String(GROUP)]?.token, undefined);
        assert.equal(sent.length, 0, 'no reply to non-admins');
        assert.equal(getChatMemberCalls - calls0, 1, 'admin status cached');

        updates = [
            msg(11, ADMIN, GROUP, `/track@marglolbot https://marg.lol/token/${CURVE}`),
            msg(12, ADMIN, GROUP, `/track@otherbot ${T1}`),
            msg(13, ADMIN, GROUP, `/track https://marg.lol/token/${T1}`),
            msg(14, ADMIN, GROUP, '/min 2'),
            msg(15, ADMIN, GROUP, '/emoji 🐸'),
            msg(16, ADMIN, GROUP, '/emoji <b>'),
            msg(17, MEMBER, GROUP, '/min 0'),
        ];
        await bot.pollUpdatesOnce(0);
        await bot.sender.flush();
        assert.deepEqual(bot.state.data.chats[String(GROUP)], { min: 2, emoji: '🐸', token: T1, symbol: 'TOK' });
        assert.equal(bot.state.data.updateOffset, 18);
        const replies = sent.map(textOf);
        assert.equal(replies.length, 5, replies.join('\n---\n'));
        assert.match(replies[0], /not a MARG token/);
        assert.match(replies[1], /Now posting buys of <code>TOK<\/code>/);
        sent.length = 0;
    });

    await run('/help and /status at most once a minute per chat', async () => {
        updates = [msg(30, MEMBER, GROUP, '/help'), msg(31, MEMBER, GROUP, '/help'), msg(32, MEMBER, GROUP, '/start'),
            msg(33, MEMBER, GROUP, '/status'), msg(34, MEMBER, GROUP, '/status'), msg(35, MEMBER, GROUP2, '/help')];
        await bot.pollUpdatesOnce(0);
        await bot.sender.flush();
        const replies = sent.map((x) => [x.params.chat_id, textOf(x)]);
        assert.equal(replies.length, 3, JSON.stringify(replies));
        assert.match(replies.find(([c, t]) => c === String(GROUP) && /Tracking/.test(t))![1], /Tracking <code>TOK<\/code>/);
        sent.length = 0;
    });

    await run('/track accepts raw and non-bounceable forms', async () => {
        const EQ = 'EQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq8Uk';
        tokens.push(tok(EQ, { symbol: 'RAW' }));
        bot.state.seen.add(EQ);
        const G = -1003;
        updates = [msg(40, ADMIN, G, '/track 0:' + 'ab'.repeat(32))];
        await bot.pollUpdatesOnce(0);
        assert.equal(bot.state.data.chats[String(G)]?.token, EQ);
        updates = [msg(41, ADMIN, G, '/untrack'), msg(42, ADMIN, G, '/track UQCrq6urq6urq6urq6urq6urq6urq6urq6urq6urq6urq5jh')];
        await bot.pollUpdatesOnce(0);
        assert.equal(bot.state.data.chats[String(G)]?.token, EQ);
        updates = [msg(43, ADMIN, G, '/untrack')];
        await bot.pollUpdatesOnce(0);
        assert.equal(bot.state.data.chats[String(G)], undefined, 'default-only entry removed on /untrack');
        await bot.sender.flush();
        sent.length = 0;
    });

    await run('chat cap, unchanged state not rewritten', async () => {
        const st = bot.state;
        st.save(); // settle
        assert.equal(st.save(), false, 'no write when nothing changed');
        const fill: string[] = [];
        for (let i = 0; Object.keys(st.data.chats).length < MAX_CHATS; i++) { const k = String(-2_000_000 - i); st.data.chats[k] = { min: 0, emoji: '🟢' }; fill.push(k); }
        const G = -1004;
        updates = [msg(50, ADMIN, G, `/track ${T1}`)];
        await bot.pollUpdatesOnce(0);
        await bot.sender.flush();
        assert.equal(st.data.chats[String(G)], undefined);
        assert.match(textOf(sent.pop()!), /capacity/);
        for (const k of fill) delete st.data.chats[k];
        st.save();
        sent.length = 0;
    });

    await run('buys above min posted, below min and sells not', async () => {
        trades = [trade(T1, 5), trade(T1, 1), trade(T1, 9, false), trade(T3, 100), ...trades];
        await bot.pollTrades();
        await bot.pollTrades();
        await bot.sender.flush();
        assert.equal(sent.length, 1, JSON.stringify(sent));
        const t = sent[0];
        assert.equal(t.params.chat_id, String(GROUP));
        assert.ok(t.params.text.startsWith('🐸'.repeat(10) + '\n'), t.params.text);
        assert.ok(t.params.text.includes('<code>TOK</code> <b>buy!</b>') && t.params.text.includes('💎 5 Gram ($10.00)') && t.params.text.includes('Market cap $5.2K'), t.params.text);
        assert.ok(t.params.text.includes(`https://tonviewer.com/${TRADER}`) && t.params.text.includes('tonviewer.com/transaction/'));
        sent.length = 0;
    });

    await run('no duplicate posts across restarts', async () => {
        bot.stop();
        bot = new Bot(cfg());
        await bot.init();
        await bot.pollLaunches();
        await bot.pollTrades();
        await bot.sender.flush();
        assert.equal(sent.length, 0);
        trades = [trade(T1, 3), ...trades];
        await bot.pollTrades();
        await bot.sender.flush();
        assert.equal(sent.length, 1);
        sent.length = 0;
    });

    await run('429 respected, then delivered', async () => {
        rate429 = 1;
        trades = [trade(T1, 4), ...trades];
        const t0 = Date.now();
        await bot.pollTrades();
        await bot.sender.flush();
        assert.equal(sent.length, 1);
        assert.ok(Date.now() - t0 >= 900, 'waited retry_after');
        sent.length = 0;
    });

    await run('403 untracks the chat', async () => {
        updates = [msg(60, ADMIN, GROUP2, `/track ${T1}`)];
        await bot.pollUpdatesOnce(0);
        await bot.sender.flush();
        assert.equal(bot.state.data.chats[String(GROUP2)]?.token, T1);
        sent.length = 0;
        forbidden.add(String(GROUP2));
        trades = [trade(T1, 10), ...trades];
        await bot.pollTrades();
        await bot.sender.flush();
        assert.equal(bot.state.data.chats[String(GROUP2)], undefined);
        assert.equal(bot.state.data.chats[String(GROUP)]?.token, T1);
        assert.equal(sent.length, 1); // GROUP still got it
        // bot removed via my_chat_member also untracks
        updates = [{ update_id: 61, my_chat_member: { chat: { id: GROUP }, new_chat_member: { status: 'kicked' } } }];
        await bot.pollUpdatesOnce(0);
        assert.equal(bot.state.data.chats[String(GROUP)], undefined);
    });

    await run('tradeSeen pruned to the re-check window', async () => {
        const st = bot.state.data;
        trades = [trade(T1, 0.1, false, st.tradeCursor! + 1), ...trades];
        st.tradeSeen['old'] = st.tradeCursor! - 5000;
        await bot.pollTrades();
        assert.ok(Object.values(st.tradeSeen).every((u) => u >= st.tradeCursor! - 900), JSON.stringify(st.tradeSeen));
    });

    await run('getUpdates errors back off; 401 exits with code 1', async () => {
        updatesError = 500;
        const t0 = Date.now();
        await bot.pollUpdatesOnce(0);
        assert.ok(Date.now() - t0 >= 900, 'backed off ~1 s');
        assert.ok(logs.some((l) => /getUpdates: 500 .*retry in 1s/.test(l)), logs.join('\n'));
        const codes: number[] = [];
        const b401 = new Bot({ ...cfg(), exit: (c) => codes.push(c) });
        updatesError = 401;
        await b401.pollUpdatesOnce(0);
        assert.deepEqual(codes, [1]);
        assert.ok(logs.some((l) => /401 Unauthorized/.test(l)));
        const b2 = new Bot({ ...cfg(), exit: (c) => codes.push(c) });
        await b2.start(); // getMe still ok here; the update loop hits 401 and exits instead of spinning
        await new Promise((r) => setTimeout(r, 100));
        assert.deepEqual(codes, [1, 1]);
        b2.stop();
        updatesError = 0;
    });

    await run('token never logged', async () => {
        assert.ok(!logs.some((l) => l.includes(TOKEN)), logs.join('\n'));
    });

    bot.stop();
    server.close();
    console.log('all tests passed');
    process.exit(0);
}

main().catch((e) => {
    console.error(e);
    process.exit(1);
});
