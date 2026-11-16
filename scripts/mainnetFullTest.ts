import { Address, beginCell, Cell, Dictionary, fromNano, toNano, TupleBuilder } from '@ton/core';
import { sha256_sync } from '@ton/crypto';
import { NetworkProvider, sleep } from '@ton/blueprint';
import { Factory } from '../build/Factory_Factory';
import { TokenMaster } from '../build/Factory_TokenMaster';
import { TokenWallet } from '../build/Factory_TokenWallet';
import { BURN_ADDRESS, defaultTiers, dexConfig, tierParams } from './params';

// Deploys a fresh factory with tiny tier targets (1.5 / 2 / 2.5 Gram), runs every launchpad function
// against it on mainnet including a real graduation into STON.fi, then switches all three tiers to
// the production curves. Admin and treasury stay with this wallet until scripts/handOver.ts runs.
// Usage: IMAGE=<https url> npx blueprint run mainnetFullTest --mainnet --mnemonic
const ROUTER = Address.parse('EQCiypoBWNIEPlarBp04UePyEj5zH0ZDHxuRNqJ1WQx3FCY-');
const PTON_WALLET = Address.parse('EQCjEo7QNUH5S2tVjYgFFdEh1pherydH9K-nrHx0aScsq7U5');

// Same TEP-64 on-chain layout as web/src/content.ts (web/ is an ES module package, so it can't be required here).
function content(meta: Record<string, string | undefined>): Cell {
    const dict = Dictionary.empty(Dictionary.Keys.BigUint(256), Dictionary.Values.Cell());
    for (const [k, v] of Object.entries({ ...meta, decimals: '9' })) {
        if (v) dict.set(BigInt('0x' + sha256_sync(k).toString('hex')), beginCell().storeUint(0, 8).storeStringTail(v).endCell());
    }
    return beginCell().storeUint(0, 8).storeDict(dict).endCell();
}

const TEST_TIERS = [tierParams(1.5), tierParams(2), tierParams(2.5)] as const;

export async function run(provider: NetworkProvider) {
    const me = provider.sender().address!;
    const results: [string, boolean, string][] = [];
    const check = (name: string, ok: boolean, detail = '') => {
        results.push([name, ok, detail]);
        console.log(`  ${ok ? '✓' : '✗'} ${name}${detail ? ' — ' + detail : ''}`);
    };

    // Toncenter without a key allows ~1 request/second.
    async function read<T>(fn: () => Promise<T>): Promise<T> {
        for (let i = 0; ; i++) {
            await sleep(1300);
            try {
                return await fn();
            } catch (e) {
                if (i > 10) throw e;
            }
        }
    }
    async function until(cond: () => Promise<boolean>, tries = 40): Promise<boolean> {
        for (let i = 0; i < tries; i++) {
            if (await read(cond).catch(() => false)) return true;
            await sleep(2000);
        }
        return false;
    }
    // A send can fail after reaching the network; only retry when it clearly did not land.
    async function send(label: string, fn: () => Promise<unknown>, landed: () => Promise<boolean>) {
        console.log(`→ ${label}`);
        await sleep(2500);
        try {
            await fn();
        } catch (e: any) {
            console.log(`  send error (${e?.message ?? e}), checking whether it landed…`);
            if (await until(landed, 10)) return true;
            await sleep(3000);
            await fn();
        }
        return until(landed);
    }
    async function inbound(op: number, from: Address): Promise<boolean> {
        const r = await fetch(`https://toncenter.com/api/v3/transactions?account=${me.toString()}&limit=10&sort=desc`);
        const j: any = await r.json();
        return (j.transactions ?? []).some((t: any) => t.in_msg?.opcode && parseInt(t.in_msg.opcode, 16) === op &&
            Address.parse(t.in_msg.source).equals(from));
    }

    // 1. Factory -------------------------------------------------------------
    const factory = provider.open(await Factory.fromInit(me, me, ...TEST_TIERS, dexConfig(ROUTER, PTON_WALLET, BURN_ADDRESS), 0n));
    console.log(`Factory ${factory.address.toString()}`);
    if (!(await provider.isContractDeployed(factory.address))) {
        await send('deploy factory', () => factory.send(provider.sender(), { value: toNano('0.3') }, null),
            () => provider.isContractDeployed(factory.address));
    }
    check('factory deployed', await provider.isContractDeployed(factory.address));
    check('admin is deployer', (await read(() => factory.getAdmin())).equals(me));
    const p = await read(() => factory.getParams(0n));
    check('test tiers: low graduates at 1.5 Gram', p.graduationTon === toNano('1.5'), `platform fee ${p.platformFeeBps} bps`);
    check('test tiers: high graduates at 2.5 Gram', (await read(() => factory.getParams(2n))).graduationTon === toNano('2.5'));

    // 2. Token A: launch with dev buy, buys, sells, slippage, transfer, burn, TEP-89, fees, admin fee
    const img = process.env.IMAGE;
    let index = await read(() => factory.getNextIndex());
    const aIndex = index;
    await send('launch token A (0.2 Gram dev buy)', () => factory.send(provider.sender(), { value: toNano('0.45') }, {
        $$type: 'CreateToken', queryId: 0n, tier: 1n, initialBuy: toNano('0.2'),
        content: content({ name: 'Marg Test A', symbol: 'MTA', description: 'Launchpad test token. Not real, do not buy.', image: img }),
    }), async () => (await factory.getNextIndex()) > aIndex);
    const A = provider.open(TokenMaster.fromAddress(await read(() => factory.getTokenAddress(aIndex))));
    const wA = provider.open(TokenWallet.fromAddress(await read(() => A.getGetWalletAddress(me))));
    console.log(`  token A ${A.address.toString()}`);
    let s = await read(() => A.getCurveState());
    check('dev buy minted in the launch tx', s.tokensSold > 0n, `${fromNano(s.tokensSold)} tokens`);
    check('1% fee on dev buy', s.platformFeesAccrued === toNano('0.002') && s.realTon === toNano('0.198'),
        `realTon ${fromNano(s.realTon)}, fees ${fromNano(s.platformFeesAccrued)}`);
    check('token A is on the mid tier', s.graduationTon === toNano('2') &&
        (await read(() => A.getCurveParams())).virtualTon === TEST_TIERS[1].virtualTon);
    check('creator recorded', (await read(() => A.getCreator())).equals(me));
    const meta = await read(() => A.getGetJettonData());
    check('jetton data: mintable, admin none', meta.mintable && meta.adminAddress === null);

    let quote = await read(() => A.getBuyQuote(toNano('0.3')));
    let sold = s.tokensSold;
    await send('buy 0.3 Gram', () => A.send(provider.sender(), { value: toNano('0.45') },
        { $$type: 'Buy', queryId: 0n, tonAmount: toNano('0.3'), minTokensOut: (quote * 99n) / 100n }),
    async () => (await A.getCurveState()).tokensSold > sold);
    s = await read(() => A.getCurveState());
    check('buy got the quoted amount', s.tokensSold - sold === quote, `${fromNano(s.tokensSold - sold)} tokens`);

    sold = s.tokensSold;
    quote = await read(() => A.getBuyQuote(toNano('0.1')));
    await send('buy with impossible slippage (must revert)', () => A.send(provider.sender(), { value: toNano('0.25') },
        { $$type: 'Buy', queryId: 0n, tonAmount: toNano('0.1'), minTokensOut: quote * 2n }), async () => true);
    await sleep(20000);
    check('slippage buy reverted, curve unchanged', (await read(() => A.getCurveState())).tokensSold === sold);

    let bal = (await read(() => wA.getGetWalletData())).balance;
    await send('sell with impossible slippage (must restore tokens)', () => wA.send(provider.sender(), { value: toNano('0.1') },
        { $$type: 'Sell', queryId: 0n, amount: bal / 10n, minTonOut: toNano('1000') }), async () => true);
    await sleep(25000);
    check('slippage sell restored the balance', (await read(() => wA.getGetWalletData())).balance === bal &&
        (await read(() => A.getCurveState())).tokensSold === sold);

    const out = await read(() => A.getSellQuote(bal / 3n));
    await send('sell a third', () => wA.send(provider.sender(), { value: toNano('0.1') },
        { $$type: 'Sell', queryId: 0n, amount: bal / 3n, minTonOut: (out * 99n) / 100n }),
    async () => (await A.getCurveState()).tokensSold < sold);
    s = await read(() => A.getCurveState());
    check('sell burned the tokens', sold - s.tokensSold === bal / 3n);

    bal = (await read(() => wA.getGetWalletData())).balance;
    const dest = BURN_ADDRESS;
    const wDest = provider.open(TokenWallet.fromAddress(await read(() => A.getGetWalletAddress(dest))));
    await send('transfer 1000 tokens to the zero address', () => wA.send(provider.sender(), { value: toNano('0.1') }, {
        $$type: 'JettonTransfer', queryId: 0n, amount: toNano('1000'), destination: dest, responseDestination: me,
        customPayload: null, forwardTonAmount: 0n, forwardPayload: beginCell().storeBit(false).endCell().asSlice(),
    }), async () => (await wA.getGetWalletData()).balance === bal - toNano('1000'));
    check('transfer delivered', (await read(() => wDest.getGetWalletData())).balance === toNano('1000'));

    const supply = (await read(() => A.getGetJettonData())).totalSupply;
    await send('burn 500 tokens', () => wA.send(provider.sender(), { value: toNano('0.1') },
        { $$type: 'JettonBurn', queryId: 0n, amount: toNano('500'), responseDestination: me, customPayload: null }),
    async () => (await A.getGetJettonData()).totalSupply === supply - toNano('500'));
    check('burn reduced total supply', (await read(() => A.getGetJettonData())).totalSupply === supply - toNano('500'));

    await send('TEP-89 wallet discovery', () => A.send(provider.sender(), { value: toNano('0.05') },
        { $$type: 'ProvideWalletAddress', queryId: 7n, ownerAddress: me, includeAddress: false }),
    () => inbound(0xd1735400, A.address));
    check('TakeWalletAddress came back', await until(() => inbound(0xd1735400, A.address), 10));

    const fees = (await read(() => A.getCurveState())).platformFeesAccrued;
    await send('pay out fees', () => A.send(provider.sender(), { value: toNano('0.05') }, { $$type: 'ClaimFees', queryId: 0n }),
        async () => (await A.getCurveState()).platformFeesAccrued === 0n);
    check('fees paid to treasury', (await read(() => A.getCurveState())).platformFeesAccrued === 0n, `${fromNano(fees)} Gram`);

    await send('admin lowers platform fee on token A to 0.5%', () => factory.send(provider.sender(), { value: toNano('0.05') },
        { $$type: 'AdminLowerPlatformFee', index: aIndex, newFeeBps: 50n }),
    async () => (await A.getCurveState()).platformFeeBps === 50n);
    check('platform fee lowered on live token', (await read(() => A.getCurveState())).platformFeeBps === 50n);

    await send('admin re-applies DEX config (UpdateDex)', () => factory.send(provider.sender(), { value: toNano('0.05') },
        { $$type: 'UpdateDex', dex: dexConfig(ROUTER, PTON_WALLET, BURN_ADDRESS) }), async () => true);
    await sleep(15000);
    check('dex config intact', (await read(() => factory.getDex())).router.equals(ROUTER));

    // 3. Token B: real graduation into STON.fi --------------------------------
    index = await read(() => factory.getNextIndex());
    const bIndex = index;
    await send('launch token B', () => factory.send(provider.sender(), { value: toNano('0.25') }, {
        $$type: 'CreateToken', queryId: 0n, tier: 0n, initialBuy: 0n,
        content: content({ name: 'Marg Test B', symbol: 'MTB', description: 'Graduation test token. Not real, do not buy.', image: img }),
    }), async () => (await factory.getNextIndex()) > bIndex);
    const B = provider.open(TokenMaster.fromAddress(await read(() => factory.getTokenAddress(bIndex))));
    console.log(`  token B ${B.address.toString()}`);
    await until(async () => (await B.getCurveState()).tonReserve > 0n);
    await send('buy 1.6 Gram on B (crosses graduation)', () => B.send(provider.sender(), { value: toNano('1.85') },
        { $$type: 'Buy', queryId: 0n, tonAmount: toNano('1.6'), minTokensOut: 0n }),
    async () => (await B.getCurveState()).graduated);
    const sb = await read(() => B.getCurveState());
    check('token B graduated', sb.graduated);
    check('curve closed: minting off', !(await read(() => B.getGetJettonData())).mintable);

    const routerWallet = await read(() => B.getGetWalletAddress(ROUTER));
    const poolArgs = new TupleBuilder();
    poolArgs.writeAddress(PTON_WALLET);
    poolArgs.writeAddress(routerWallet);
    const pool = await read(async () => (await provider.provider(ROUTER).get('get_pool_address', poolArgs.build())).stack.readAddress());
    console.log(`  STON.fi pool ${pool.toString()}`);
    const poolLive = await until(() => provider.isContractDeployed(pool));
    check('STON.fi pool created', poolLive);
    if (poolLive) {
        const d = await read(async () => (await provider.provider(pool).get('get_pool_data', [])).stack);
        d.readBoolean(); d.readAddress();
        const lpSupply = d.readBigNumber();
        const r0 = d.readBigNumber();
        const r1 = d.readBigNumber();
        const t0 = d.readAddress();
        const [gram, tok] = t0.equals(PTON_WALLET) ? [r0, r1] : [r1, r0];
        check('pool holds the raised Gram and remaining supply', gram > 0n && tok === p.maxSupply - sb.tokensSold,
            `${fromNano(gram)} Gram / ${fromNano(tok)} tokens`);
        const lpArgs = new TupleBuilder();
        lpArgs.writeAddress(BURN_ADDRESS);
        const lpWallet = await read(async () => (await provider.provider(pool).get('get_wallet_address', lpArgs.build())).stack.readAddress());
        const burned = await read(async () => (await provider.provider(lpWallet).get('get_wallet_data', [])).stack.readBigNumber());
        check('LP sent to the burn address', burned > 0n, `${Number((burned * 10000n) / lpSupply) / 100}% of LP supply`);
    }

    // 4. Switch to the production curve ----------------------------------------
    const prod = defaultTiers();
    for (const tier of [0, 1, 2]) {
        await send(`UpdateParams tier ${tier} -> production`, () => factory.send(provider.sender(), { value: toNano('0.05') },
            { $$type: 'UpdateParams', tier: BigInt(tier), params: prod[tier], launchFee: 0n }),
        async () => (await factory.getParams(BigInt(tier))).graduationTon === prod[tier].graduationTon);
        const np = await read(() => factory.getParams(BigInt(tier)));
        check(`tier ${tier} production params live`, np.virtualTon === prod[tier].virtualTon,
            `graduates at ${fromNano(np.graduationTon)} Gram, start mcap ${Number(fromNano((np.virtualTon * np.maxSupply) / np.virtualTokens)).toFixed(0)} Gram`);
    }

    const failed = results.filter((r) => !r[1]);
    console.log(`\n${results.length - failed.length}/${results.length} checks passed`);
    console.log(`FACTORY=${factory.address.toString()} TOKEN_A=${A.address.toString()} TOKEN_B=${B.address.toString()}`);
}
