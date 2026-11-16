// Generates a new keeper wallet. Writes the mnemonic (as an EnvironmentFile line,
// KEEPER_MNEMONIC="...") to the given path with mode 0600 and prints ONLY the address.
//   NETWORK=mainnet npm run gen-wallet -- /etc/tron-keeper.env
import { writeFileSync } from 'node:fs';
import { mnemonicNew, mnemonicToPrivateKey } from '@ton/crypto';
import { walletFor } from './wallet';

async function main() {
    const path = process.argv[2];
    if (!path) {
        console.error('usage: gen-wallet <output file>   (NETWORK=mainnet|testnet, default mainnet)');
        process.exit(2);
    }
    const network = process.env.NETWORK === 'testnet' ? 'testnet' : 'mainnet';
    const words = await mnemonicNew(24);
    const keys = await mnemonicToPrivateKey(words);
    const wallet = walletFor(keys.publicKey, network);
    // 'wx': never overwrite an existing key file.
    writeFileSync(path, `KEEPER_MNEMONIC="${words.join(' ')}"\nNETWORK=${network}\n`, { mode: 0o600, flag: 'wx' });
    const testOnly = network === 'testnet';
    console.log(`network: ${network}`);
    console.log(`address (fund this): ${wallet.address.toString({ bounceable: false, testOnly })}`);
    console.log(`address (raw):       ${wallet.address.toRawString()}`);
    console.log(`mnemonic written to ${path} (mode 0600)`);
}

main().catch((e) => {
    console.error(e?.code === 'EEXIST' ? 'refusing to overwrite an existing file' : String(e?.message ?? e));
    process.exit(1);
});
