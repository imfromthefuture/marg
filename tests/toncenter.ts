import { RemoteBlockchainStorageClient } from '@ton/sandbox';
import { Address, Cell, Dictionary } from '@ton/core';

// Minimal Toncenter v2 client for forking mainnet state into the sandbox.
// Without TONCENTER_API_KEY the public limit is 1 request/second, so calls are throttled.
const BASE = 'https://toncenter.com/api/v2';
let lastCall = 0;

async function call(method: string, query: Record<string, string>): Promise<any> {
    const key = process.env.TONCENTER_API_KEY;
    const minGap = key ? 120 : 1500;
    const qs = new URLSearchParams(query).toString();
    for (let attempt = 0; ; attempt++) {
        const wait = lastCall + minGap * (attempt + 1) - Date.now();
        if (wait > 0) await new Promise((r) => setTimeout(r, wait));
        lastCall = Date.now();

        const res = await fetch(`${BASE}/${method}?${qs}`, { headers: key ? { 'X-API-Key': key } : {} });
        const json: any = await res.json();
        if (json.ok) return json.result;
        // Back off and retry when rate limited.
        if (json.code !== 429 || attempt >= 5) throw new Error(`toncenter ${method}: ${JSON.stringify(json)}`);
    }
}

export const toncenterClient: RemoteBlockchainStorageClient = {
    async getLastBlockSeqno() {
        return (await call('getMasterchainInfo', {})).last.seqno;
    },
    async getAccount(_seqno: number, address: Address) {
        const r = await call('getAddressInformation', { address: address.toString() });
        const balance = BigInt(r.balance);
        const last = r.last_transaction_id && r.last_transaction_id.lt !== '0'
            ? { lt: BigInt(r.last_transaction_id.lt), hash: Buffer.from(r.last_transaction_id.hash, 'base64') }
            : undefined;
        if (r.state === 'active') {
            return {
                state: {
                    type: 'active',
                    state: {
                        code: r.code ? Cell.fromBase64(r.code) : undefined,
                        data: r.data ? Cell.fromBase64(r.data) : undefined,
                    },
                },
                balance,
                lastTransaction: last,
            };
        }
        if (r.state === 'frozen') {
            return { state: { type: 'frozen', stateHash: BigInt('0x' + Buffer.from(r.frozen_hash ?? '', 'base64').toString('hex')) }, balance, lastTransaction: last };
        }
        return { state: { type: 'uninit' }, balance, lastTransaction: last };
    },
};

// Library cells referenced from code/data (STON.fi v2 stores its code as libraries).
function collectLibraryHashes(cell: Cell, out: Set<string>, seen = new Set<string>()) {
    const h = cell.hash().toString('hex');
    if (seen.has(h)) return;
    seen.add(h);
    if (cell.isExotic && cell.type === 2) {
        // library cell: 8-bit type tag followed by the 256-bit library hash
        out.add(cell.beginParse(true).skip(8).loadBuffer(32).toString('hex'));
        return;
    }
    for (const ref of cell.refs) collectLibraryHashes(ref, out, seen);
}

export async function fetchLibraries(cells: Cell[]): Promise<Dictionary<Buffer, Cell>> {
    const hashes = new Set<string>();
    cells.forEach((c) => collectLibraryHashes(c, hashes));
    const libs = Dictionary.empty(Dictionary.Keys.Buffer(32), Dictionary.Values.Cell());
    // Libraries can reference further libraries; resolve until nothing new appears.
    const pending = [...hashes];
    while (pending.length) {
        const hex = pending.pop()!;
        const r = await call('getLibraries', { libraries: Buffer.from(hex, 'hex').toString('base64') });
        const lib = r.result?.[0];
        if (!lib) throw new Error(`library ${hex} not found`);
        const cell = Cell.fromBase64(lib.data);
        libs.set(Buffer.from(hex, 'hex'), cell);
        const nested = new Set<string>();
        collectLibraryHashes(cell, nested);
        for (const n of nested) if (!libs.has(Buffer.from(n, 'hex')) && !pending.includes(n)) pending.push(n);
    }
    return libs;
}
