import { Link } from 'react-router-dom';

// Placeholder for the Marg DEX pages until the DEX is on mainnet.
export function Soon({ what }: { what: 'swap' | 'pools' }) {
    return (
        <div className="narrow">
            <div className="card empty">
                <span className="pill blue">Marg DEX · coming soon</span>
                <h2 style={{ marginTop: 14 }}>{what === 'swap' ? 'Swap any token on Marg DEX' : 'Provide liquidity in your own range'}</h2>
                <p>
                    {what === 'swap'
                        ? 'Concentrated liquidity with a dynamic fee that rises when the market moves. Every Marg launch trades here from its first block.'
                        : 'Pick a price range, earn fees while the price is inside it, and hold the position as an NFT.'}
                </p>
                <Link to="/" className="button primary">Discover tokens</Link>
            </div>
        </div>
    );
}
