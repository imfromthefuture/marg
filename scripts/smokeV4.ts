import { Address, beginCell, Cell, Dictionary, toNano } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import { NetworkProvider } from '@ton/blueprint';
import { LaunchFactory, storeCreateToken } from '../launch/build/Launch_LaunchFactory';
import { LaunchJetton } from '../launch/build/Launch_LaunchJetton';
import { Router } from '../dex/v2/build/Router_Router';

// v4 mainnet smoke launch: a taxed token (1% / 1%, 50% holder rewards, 50% buyback) with a small dev buy,
// launched straight on the Low tier. Then a holders-only CreateToken, which the factory must refuse and
// refund (audit R10-1). Prints the token, its pool and its state.
// Usage: FACTORY=<a> ROUTER=<a> [DEV_BUY=1] [IMAGE=<url>] npx blueprint run smokeV4 --mainnet --mnemonic
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

// TEP-64 on-chain content (as web/src/content.ts, which is an ES module).
function buildOnchainContent(m: { name: string; symbol: string; description?: string; image?: string }): Cell {
    const key = (k: string) => BigInt('0x' + sha256_sync(k).toString('hex'));
    const snake = (v: string) => beginCell().storeUint(0, 8).storeStringTail(v).endCell();
    const d = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    d.set(key('name'), snake(m.name));
    d.set(key('symbol'), snake(m.symbol));
    d.set(key('decimals'), snake('9'));
    if (m.description) d.set(key('description'), snake(m.description));
    if (m.image) d.set(key('image'), snake(m.image));
    return beginCell().storeUint(0, 8).storeDict(d).endCell();
}

export async function run(provider: NetworkProvider) {
    const factory = provider.open(LaunchFactory.fromAddress(Address.parse(process.env.FACTORY!)));
    const router = provider.open(Router.fromAddress(Address.parse(process.env.ROUTER!)));
    const devBuy = toNano(process.env.DEV_BUY ?? '1');
    const fd = await factory.getGetFactoryData();
    const tier = fd.tiers.low;
    const body = (rewardsBps: bigint, buybackBps: bigint, dev: bigint) => beginCell().store(storeCreateToken({
        $$type: 'CreateToken', queryId: 0n,
        content: buildOnchainContent({ name: 'MARG v4 smoke', symbol: 'MSMK', description: 'MARG v4 deploy check', image: process.env.IMAGE || undefined }),
        devBuy: dev, minDevOut: 0n, buyTaxBps: 100n, sellTaxBps: 100n, taxWallet: null,
        rewardsBps, walletBps: 0n, buybackBps, antiSnipePips: 0n, antiSnipeDuration: 0n,
        startMcap: tier.startMcap, tickSpacing: tier.tickSpacing, vaultBps: 0n, vaultLock: 0n, vaultVest: 0n,
    })).endCell();

    const idx = fd.nextIndex;
    const value = (await factory.getGetCreateValue2(devBuy, false)) + toNano('0.05');
    console.log(`Launching index ${idx} with ${Number(value) / 1e9} Gram (dev buy ${Number(devBuy) / 1e9})`);
    await provider.sender().send({ to: factory.address, value, body: body(5000n, 5000n, devBuy) });
    const master = provider.open(LaunchJetton.fromAddress(await factory.getGetTokenAddress(idx)));
    let ok = false;
    for (let i = 0; i < 40 && !ok; i++) {
        await sleep(4000);
        try { ok = (await master.getGetLaunchState()).settled; } catch { /* not deployed yet */ }
    }
    console.log('Token     ', master.address.toString(), 'settled', ok);
    if (!ok) throw new Error('launch not settled');
    await sleep(8000);
    const key = await master.getGetPoolKey();
    const pool = await router.getGetPoolAddress(key.token0, key.token1, key.tickSpacing, key.ext);
    console.log('Pool      ', pool.toString());
    console.log('Launched  ', await master.getGetLaunched());
    console.log('LaunchState', JSON.stringify(await master.getGetLaunchState(), (_k, v) => typeof v === 'bigint' ? v.toString() : v));
    console.log('Rewards   ', JSON.stringify(await master.getGetRewardsData(), (_k, v) => typeof v === 'bigint' ? v.toString() : v));
    const me = provider.sender().address!;
    console.log('Dev wallet', (await master.getGetWalletAddress(me)).toString());

    // R10-1 on mainnet: holders-only must be refused (value back, no new token).
    await sleep(5000);
    const n0 = (await factory.getGetFactoryData()).nextIndex;
    await provider.sender().send({ to: factory.address, value: await factory.getGetCreateValue2(0n, false), body: body(10000n, 0n, 0n) });
    await sleep(25000);
    const n1 = (await factory.getGetFactoryData()).nextIndex;
    console.log('Holders-only refused:', n1 === n0, `(nextIndex ${n0} -> ${n1})`);
}
