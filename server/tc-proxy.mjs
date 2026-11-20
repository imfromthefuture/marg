// Toncenter v2 JSON-RPC method allowlist for the web app's /toncenter proxy (audit R2-M4). No dependencies.
//
// nginx cannot look inside a JSON body before it proxies (no njs on the server; $request_body is empty in
// the rewrite phase), so it sends /toncenter/api/v2/jsonRPC here first. This service accepts only a single
// JSON-RPC call (no batches) whose method is one of the read methods the web app uses, and forwards it to
// Toncenter with the X-API-Key header nginx added (the key itself stays in nginx's
// /etc/nginx/marg-toncenter-key.conf). Everything else, sendBoc / estimateFee / sendQuery included, gets
// 403. nginx keeps doing the Origin check, the per-IP and global rate limits and the 4 s cache in front.
//
// The methods come from web/src: TonClient.runMethod / contract getters (runGetMethod), getContractState /
// getBalance (getAddressInformation) and the C8 top-up probe (getTransactions, limit 1). Add a method here
// only when the web app starts using it. The web app never broadcasts through this proxy: transactions go
// through the user's wallet (TonConnect).
//
// The indexer and the keeper do NOT use this proxy: each has its own Toncenter key (TONCENTER_API_KEY in
// /etc/tron-indexer.env and /etc/tron-keeper.env), so browser traffic cannot use up their limit.
import http from 'node:http';

const PORT = Number(process.env.PORT ?? 8812);
const UPSTREAM = process.env.TONCENTER_UPSTREAM ?? 'https://toncenter.com/api/v2/jsonRPC';
const MAX_BODY = 64 * 1024;
const ALLOWED = new Set(['runGetMethod', 'getAddressInformation', 'getTransactions']);
// getTransactions is capped: the web app reads one transaction (the C8 probe).
const MAX_TX_LIMIT = 10;

function refuse(res, status, message) {
    res.writeHead(status, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
    res.end(JSON.stringify({ ok: false, error: message, code: status }));
}

// The call if it is allowed, else a reason string.
function check(body) {
    let rpc;
    try { rpc = JSON.parse(body); } catch { return 'bad JSON'; }
    if (!rpc || typeof rpc !== 'object' || Array.isArray(rpc)) return 'one JSON-RPC call per request';
    if (typeof rpc.method !== 'string' || !ALLOWED.has(rpc.method)) return 'method not allowed';
    if (rpc.params !== undefined && (typeof rpc.params !== 'object' || rpc.params === null || Array.isArray(rpc.params))) return 'bad params';
    if (rpc.method === 'getTransactions' && Number(rpc.params?.limit ?? 10) > MAX_TX_LIMIT) return 'limit too large';
    return rpc;
}

http.createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/api/v2/jsonRPC') return refuse(res, 404, 'not found');
    const chunks = [];
    let size = 0;
    req.on('data', (c) => {
        size += c.length;
        if (size > MAX_BODY) { refuse(res, 413, 'too large'); req.destroy(); return; }
        chunks.push(c);
    });
    req.on('end', async () => {
        if (res.writableEnded) return;
        const rpc = check(Buffer.concat(chunks).toString('utf8'));
        if (typeof rpc === 'string') return refuse(res, 403, rpc);
        try {
            const headers = { 'Content-Type': 'application/json' };
            const key = req.headers['x-api-key'];
            if (typeof key === 'string' && key) headers['X-API-Key'] = key;
            const up = await fetch(UPSTREAM, {
                method: 'POST', headers, signal: AbortSignal.timeout(20_000),
                body: JSON.stringify({ id: rpc.id ?? 1, jsonrpc: '2.0', method: rpc.method, params: rpc.params ?? {} }),
            });
            const text = await up.text();
            res.writeHead(up.status, { 'Content-Type': up.headers.get('content-type') ?? 'application/json' });
            res.end(text);
        } catch (e) {
            refuse(res, 502, 'upstream error');
        }
    });
    req.on('error', () => { if (!res.writableEnded) refuse(res, 400, 'bad request'); });
}).listen(PORT, '127.0.0.1', () => console.log(`toncenter allowlist proxy on 127.0.0.1:${PORT} -> ${UPSTREAM}`));
