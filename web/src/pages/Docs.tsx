import { Link } from 'react-router-dom';

const SECTIONS: [string, string][] = [
    ['overview', 'Overview'],
    ['launch', 'Launching a token'],
    ['trading', 'Trading'],
    ['fees', 'Fees'],
    ['tax', 'Tax tokens'],
    ['liquidity', 'Providing liquidity'],
    ['vaults', 'Vaults'],
    ['safety', 'Safety and open source'],
    ['faq', 'FAQ'],
];

export function Docs() {
    return (
        <div className="docs">
            <aside className="docs-nav">
                <span className="field-label">Docs</span>
                {SECTIONS.map(([id, title]) => <a key={id} href={`#${id}`}>{title}</a>)}
            </aside>

            <article className="docs-body">
                <h1>MARG docs</h1>
                <p className="dim">How launching, trading and liquidity work on Marg, the launchpad and DEX on TON.</p>

                <section id="overview">
                    <h2>Overview</h2>
                    <p>
                        Marg has two parts. The <b>launchpad</b> creates a token and puts its whole supply into a pool in
                        one transaction. <b>Marg DEX</b> is where every token trades: a concentrated-liquidity exchange with
                        a fee that rises when the market moves fast.
                    </p>
                    <p>
                        There is no bonding curve and no graduation. A token is tradable on the DEX from its first block,
                        at a fixed starting market cap, with liquidity that can never be removed.
                    </p>
                </section>

                <section id="launch">
                    <h2>Launching a token</h2>
                    <ol>
                        <li>Open <Link to="/create">Launch</Link>, connect your wallet and fill in name, ticker, description and picture.</li>
                        <li>Optionally add a dev buy, an anti-snipe fee, and a buy and sell tax with its split.</li>
                        <li>Confirm one transaction. The token, its pool and your dev buy are all created by it.</li>
                    </ol>
                    <table className="docs-table">
                        <tbody>
                            <tr><td>Supply</td><td>1,000,000,000 tokens, 9 decimals. Minted once; minting is closed for good and the token has no admin.</td></tr>
                            <tr><td>Liquidity</td><td>You pick a tier: <b>Low</b> starts at about 2,600 Gram market cap, <b>Mid</b> at 10,000, <b>High</b> at 30,000. The whole supply sits in the pool either way; a higher start is a deeper pool, so each buy moves the price less (10 Gram lifts Low about 0.8%, High about 0.07%).</td></tr>
                            <tr><td>Liquidity</td><td>Locked forever. No one, including Marg, can withdraw it.</td></tr>
                            <tr><td>Dev buy</td><td>Runs inside the launch transaction, so nobody can buy before you. You don't pay the anti-snipe fee on it.</td></tr>
                            <tr><td>Anti-snipe</td><td>Optional. An extra fee on buys right after launch that fades to 0 second by second, so bots gain little by buying first. You choose it, for example 90% over 15 seconds or 15% over 5 minutes, up to 90% and 1 hour. It never applies to your dev buy.</td></tr>
                            <tr><td>Cost</td><td>A small launch fee plus network gas; unused gas is refunded. The exact amount is shown before you confirm.</td></tr>
                        </tbody>
                    </table>
                </section>

                <section id="trading">
                    <h2>Trading</h2>
                    <p>
                        Buy and sell from a token's page, or swap any pair on Marg DEX. Every trade shows the expected
                        amount, the minimum you'll accept (slippage) and the fee before you sign. If the price moves past
                        your minimum, the trade is refunded instead of filled.
                    </p>
                    <p>
                        Gram is used directly in pools, with no wrapped TON. A trade can also partly fill and refund the rest
                        if you allow it.
                    </p>
                </section>

                <section id="fees">
                    <h2>Fees</h2>
                    <p>Each pool has a fee tier. On top of the base fee, a variable fee rises while the price is moving fast and decays when it calms down. That pays liquidity providers more exactly when they take the most risk.</p>
                    <table className="docs-table">
                        <thead><tr><th>Tier</th><th>Base fee</th><th>Variable, at most</th><th>Typical use</th></tr></thead>
                        <tbody>
                            <tr><td>Stable</td><td>0.01%</td><td>+0.05%</td><td>Stablecoin pairs</td></tr>
                            <tr><td>Low</td><td>0.05%</td><td>+0.49%</td><td>Major pairs</td></tr>
                            <tr><td>Standard</td><td>0.30%</td><td>+1.98%</td><td>Most pairs, e.g. Gram/USDT</td></tr>
                            <tr><td>High</td><td>1.00%</td><td>+2.94%</td><td>Very volatile pairs</td></tr>
                        </tbody>
                    </table>
                    <p className="dim small">The total of base and variable fee is capped at 5%. It goes to the pool's liquidity providers, paid in the token the trader puts in; 10% of it is the MARG protocol share.</p>
                    <h3>Launchpad tokens</h3>
                    <p>Tokens launched on MARG trade in a pool on the Low tier (0.05% base fee) and pay a <b>platform fee of 1%</b> on every buy and sell, always in Gram: on a buy it comes off the Gram you pay, on a sell off the Gram you receive. It goes straight to the MARG treasury in the same transaction. MARG can lower it (and raise it again), but never above 1%.</p>
                    <p>A creator can add their own tax of 1–5% per side (see Tax tokens), also in Gram. Example: a token with a 3% buy tax costs about 1% + 3% + 0.05% on a buy. The amounts shown before you sign always include every fee.</p>
                </section>

                <section id="tax">
                    <h2>Tax tokens</h2>
                    <p>
                        When launching, you can turn on a buy tax and a sell tax of 1% to 5% each (or leave either at 0).
                        The tax is taken in Gram on every trade on the token's pool. You then decide where it goes by
                        splitting 100% of it between three uses:
                    </p>
                    <table className="docs-table">
                        <tbody>
                            <tr><td>Holder rewards</td><td>Paid out in Gram to everyone holding the token, by how much they hold. Holders claim it on the token page.</td></tr>
                            <tr><td>Wallet</td><td>Sent to your wallet, or to another address you enter.</td></tr>
                            <tr><td>Buyback &amp; burn</td><td>Buys the token on its own pool and burns what it buys. It runs on each payout, in small steps at most once every 5 minutes, so it can't be used to move the price in one go.</td></tr>
                        </tbody>
                    </table>
                    <p>
                        The tax is paid out automatically: as soon as about 0.1 Gram has collected, the next trade sends it
                        to the token, which splits it as set at launch. Anyone can also trigger a payout early with
                        “Collect now” on the token page.
                    </p>
                    <p>
                        For example, a 3% tax split 50 / 20 / 30 sends half to holders, a fifth to your wallet and the rest
                        to buyback &amp; burn. The Launch page has presets and sliders for this.
                    </p>
                    <p>
                        Taxes and the split are fixed at launch and can never be raised, lowered or turned on later. The token
                        itself is a normal jetton: transfers between wallets are never taxed, only trades on the pool. With
                        holder rewards on, a transfer costs a little more gas (about 0.1 Gram), because rewards are tracked on
                        every transfer.
                    </p>
                </section>

                <section id="liquidity">
                    <h2>Providing liquidity</h2>
                    <p>
                        On Marg DEX you choose a price range for your liquidity. While the price is inside your range, you
                        earn fees from every trade; outside it, your position holds only one of the two tokens and earns
                        nothing until the price comes back. Narrower ranges earn more per Gram but go out of range sooner.
                    </p>
                    <p>Each position is an NFT in your wallet. You can add to it, remove from it and collect its fees at any time.</p>
                </section>

                <section id="vaults">
                    <h2>Vaults <span className="pill blue">coming soon</span></h2>
                    <p>
                        Vaults manage a range for you. Deposit Gram, USDT or both and receive vault shares. The vault keeps
                        its liquidity around the current price, compounds fees, and rebalances when the price moves.
                    </p>
                    <ul>
                        <li>Withdrawals can never be paused. You always get your share of both tokens back.</li>
                        <li>Deposits are refused while the price has just been pushed away from its recent average.</li>
                        <li>A 10% performance fee on earned fees goes to the treasury; it can never exceed 20%.</li>
                        <li>The admin cannot move funds or block withdrawals.</li>
                    </ul>
                </section>

                <section id="safety">
                    <h2>Safety and open source</h2>
                    <ul>
                        <li>All Marg contracts and this website are open source under the MIT license.</li>
                        <li>Launched tokens have no admin and no mint; launch liquidity is locked forever.</li>
                        <li>Admin powers are capped in code: fees can only stay within fixed limits, and no admin action can touch user funds or positions.</li>
                        <li>The new launchpad, DEX and vault contracts have not been audited yet. An external audit is planned before they hold large amounts.</li>
                    </ul>
                    <p className="dim small">Trading new tokens is risky. Prices can go to zero, and taxes and fees reduce what you receive. Only use money you can afford to lose.</p>
                </section>

                <section id="faq">
                    <h2>FAQ</h2>
                    <h3>Why no bonding curve?</h3>
                    <p>A curve only delays real trading. Starting directly on the DEX gives full liquidity, a real price and one venue from the first block.</p>
                    <h3>Can a creator rug the liquidity?</h3>
                    <p>No. The launch liquidity is held in a locked position that has no withdrawal path.</p>
                    <h3>What is Gram?</h3>
                    <p>Gram is the native coin of TON, the coin that pays for everything on Marg.</p>
                    <h3>How do I get holder rewards?</h3>
                    <p>Hold a token that has holder rewards turned on. Your share builds up automatically; claim it in Gram on the token's page whenever you like.</p>
                    <h3>Where do I see my tokens?</h3>
                    <p>In your TON wallet. Marg never holds your tokens; every trade settles directly to your wallet.</p>
                    <h3>Where do I follow MARG?</h3>
                    <p>On X at <a href="https://x.com/Marg_lol" target="_blank" rel="noreferrer">@Marg_lol</a> and on Telegram at <a href="https://t.me/marglolportal" target="_blank" rel="noreferrer">t.me/marglolportal</a>. New launches: <a href="https://t.me/marglollaunches" target="_blank" rel="noreferrer">t.me/marglollaunches</a>. Source code: <a href="https://github.com/imfromthefuture/marg" target="_blank" rel="noreferrer">github.com/imfromthefuture/marg</a>. Official links are only the ones shown on marg.lol.</p>
                    <h3>How do I get buy alerts in my token's Telegram group?</h3>
                    <p>Add <a href="https://t.me/marglolbot" target="_blank" rel="noreferrer">@marglolbot</a> to your group as an admin and type <code>/track</code> followed by your token's address. Every buy is then posted in the group with the amount, market cap and a chart link. <code>/min 1</code> hides buys under 1 Gram, <code>/untrack</code> stops it.</p>
                </section>
            </article>
        </div>
    );
}
