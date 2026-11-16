import { useEffect, useState } from 'react';
import { Address, beginCell } from '@ton/core';
import { useTonAddress, useTonConnectUI } from '@tonconnect/ui-react';
import { LaunchVault, storeClaimVault, type VaultData } from '../../launch/build/Launch_LaunchVault';
import { client, fmtTokens, fmtTon, q } from './ton';
import type { LaunchInfo } from './dex';

const day = 86400;
const fmtDate = (t: bigint) => new Date(Number(t) * 1000).toLocaleDateString('en-US', { day: 'numeric', month: 'short', year: 'numeric' });

// Creator vault of a launch token: the share of supply locked for the creator, its schedule, and the
// creator's Claim button. Only shown when the launch has a vault (info.vaultBps > 0).
export function VaultCard({ master, info, symbol }: { master: Address; info: LaunchInfo; symbol: string }) {
    const [tonConnect] = useTonConnectUI();
    const owner = useTonAddress(false);
    const [vault, setVault] = useState<Address | null>(null);
    const [data, setData] = useState<VaultData | null>(null);
    const [status, setStatus] = useState<string | null>(null);

    async function load() {
        const r = await q(() => client.runMethod(master, 'get_vault_address')).catch(() => null);
        const v = r?.stack.readAddressOpt() ?? null;
        setVault(v);
        if (v) setData(await q(() => client.open(LaunchVault.fromAddress(v)).getGetVaultData()).catch(() => null));
    }
    useEffect(() => { if (info.vaultBps > 0n) load(); }, [master.toRawString()]);

    if (info.vaultBps === 0n) return null;
    const pct = Number(info.vaultBps) / 100;
    const unlockAt = info.createdAt + info.vaultLock;
    const fullAt = unlockAt + info.vaultVest;
    const isOwner = !!owner && !!data && data.beneficiary.equals(Address.parse(owner));

    async function claim() {
        if (!owner) return tonConnect.openModal();
        if (!vault) return;
        try {
            setStatus('Confirm in your wallet…');
            const value = await q(() => client.open(LaunchVault.fromAddress(vault)).getGetClaimValue());
            const body = beginCell().store(storeClaimVault({ $$type: 'ClaimVault', queryId: 0n })).endCell();
            await tonConnect.sendTransaction({
                validUntil: Math.floor(Date.now() / 1000) + 300,
                messages: [{ address: vault.toString(), amount: value.toString(), payload: body.toBoc().toString('base64') }],
            });
            setStatus(`Claim sent. The ${symbol} arrive in your wallet in a few seconds.`);
            setTimeout(load, 15_000);
        } catch (e: any) {
            setStatus(e?.message?.includes('Reject') ? 'Cancelled in wallet' : `Error: ${e?.message ?? e}`);
        }
    }

    return (
        <div className="card info-box">
            <div className="info-head">
                <h3>Creator vault</h3>
                <span className="pill blue">{pct}% of supply</span>
            </div>
            <div className="row small"><span className="hint">Locked in the vault</span><b className="mono">{data ? fmtTokens(data.total) : fmtTokens(BigInt(Math.round(pct * 1e7)) * 10n ** 9n)} {symbol}</b></div>
            <div className="row small"><span className="hint">Locked until</span><b className="mono">{fmtDate(unlockAt)}</b></div>
            <div className="row small"><span className="hint">Unlock</span><b className="mono">{info.vaultVest === 0n ? 'all at once' : `gradually until ${fmtDate(fullAt)} (${Number(info.vaultVest) / day} days)`}</b></div>
            <div className="row small"><span className="hint">Claimed by the creator</span><b className="mono">{data ? `${fmtTokens(data.claimed)} ${symbol}` : '—'}</b></div>
            {isOwner && data && (
                <div className="reward-claim">
                    <div>
                        <span className="hint small">You can claim now</span>
                        <b className="mono">{fmtTokens(data.claimableNow)} {symbol}</b>
                    </div>
                    <button className="button primary" onClick={claim} disabled={data.claimableNow === 0n}>Claim</button>
                </div>
            )}
            {status && <div className="status">{status}</div>}
            <p>
                These tokens were set aside for the creator at launch and stay in the vault until the lock ends; nobody,
                including MARG, can release them early. A claim sends 0.15 Gram for gas; about 0.015 is used and the rest comes back.
            </p>
        </div>
    );
}
