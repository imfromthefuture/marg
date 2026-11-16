// Keeper wallet: WalletContractV5R1 (subwallet 0) from a 24-word mnemonic. The mnemonic is only
// ever read from the environment (or written once by gen-wallet); it is never logged.
import { mnemonicToPrivateKey } from '@ton/crypto';
import { WalletContractV5R1 } from '@ton/ton';

export type Network = 'mainnet' | 'testnet';

export function walletFor(publicKey: Buffer, network: Network) {
    return WalletContractV5R1.create({
        publicKey,
        walletId: {
            networkGlobalId: network === 'mainnet' ? -239 : -3,
            context: { walletVersion: 'v5r1', workchain: 0, subwalletNumber: 0 },
        },
    });
}

export async function keysFrom(mnemonic: string) {
    const words = mnemonic.trim().split(/\s+/);
    if (words.length !== 24) throw new Error('KEEPER_MNEMONIC must have 24 words');
    return mnemonicToPrivateKey(words);
}
