import { Address, beginCell, toNano } from '@ton/core';
import { NetworkProvider } from '@ton/blueprint';

// Sweeps spare Gram from retired MARG Routers and launch factories to their treasury (the user's wallet),
// via the admin-only excess withdrawals (each contract keeps its own small storage reserve).
// Usage: [DRY_RUN=1] npx blueprint run sweepOld --mainnet --mnemonic
const OP_ROUTER_EXCESS = 0x4d480019;   // WithdrawRouterExcess (dex/v2)
const OP_FACTORY_EXCESS = 0x4d4c0015;  // WithdrawExcess (launch factory)
const OLD: [string, number][] = [
    ['EQDLESCCEEWSmDW3hP9yBTQqc5tAfoBWzd1LRmSn6QaVuAdq', OP_ROUTER_EXCESS],   // Router v1
    ['EQCZ78CikhSIXwNUEgbeGb9K6ETnksqOXlxnfU6eESe4rBQ-', OP_ROUTER_EXCESS],   // Router v2
    ['EQD8x3cARfTZsZWdv-EEA8EGcxxhq9iikxx7KAFMnwgBZbdT', OP_FACTORY_EXCESS],  // launch factory v1
    ['EQA-ODoYCcBCTeZbLqGI4VaPcyNrXLwt9FiliBIGUM6yOtXr', OP_FACTORY_EXCESS],  // launch factory v2
    ['EQAgm8yFcxxu2uzJ_qcc5umAUa0nmVSAQVbK04fzaXmd6PiH', OP_FACTORY_EXCESS],  // launch factory v3
    ['EQAYcJ4RHb_geFMRcsyVWMXgODB5iYqGStZbfrUZP1q5Ulc4', OP_FACTORY_EXCESS],  // launch factory v4
];

export async function run(provider: NetworkProvider) {
    console.log('Admin', provider.sender().address!.toString());
    for (const [a, op] of OLD) {
        console.log(`${process.env.DRY_RUN ? '[dry run] ' : ''}withdraw excess ${a} (op 0x${op.toString(16)})`);
        if (process.env.DRY_RUN) continue;
        await provider.sender().send({
            to: Address.parse(a),
            value: toNano('0.05'),
            bounce: true,
            body: beginCell().storeUint(op, 32).storeUint(0, 64).endCell(),
        });
        await new Promise((r) => setTimeout(r, 12000)); // let the wallet's seqno advance
    }
}
