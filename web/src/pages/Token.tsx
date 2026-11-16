import { lazy, Suspense, useEffect, useMemo, useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Address } from '@ton/core';
import { isLaunchToken } from '../dexenv';

const DexTokenPage = lazy(() => import('./DexToken').then((m) => ({ default: m.DexTokenPage })));

// Only genuine MARG direct launches (launch/) get a token page. get_launch_info plus a MARG
// factory listing the master at its own index tells them apart from copies and other jettons.
export function Token() {
    const { address: param } = useParams();
    const address = useMemo(() => {
        try {
            return Address.parse(param ?? '');
        } catch {
            return null;
        }
    }, [param]);
    const [kind, setKind] = useState<'launch' | 'fake' | 'other' | null>(null);
    const [error, setError] = useState<string | null>(null);
    const [attempt, setAttempt] = useState(0);

    useEffect(() => {
        if (!address) return;
        let alive = true;
        setKind(null);
        setError(null);
        isLaunchToken(address)
            .then((r) => alive && setKind(r === 'fake' ? 'fake' : r === true ? 'launch' : 'other'))
            .catch((e) => alive && setError(e?.message ?? String(e)));
        return () => { alive = false; };
    }, [address?.toRawString(), attempt]);

    if (!address) return <div className="card error">Invalid token address</div>;
    if (error) return <div className="card error">{error} <button className="button ghost" onClick={() => setAttempt((a) => a + 1)}>Retry</button></div>;
    if (!kind) return <div className="card skeleton tall" />;
    if (kind === 'fake') return <div className="card error">This token was not launched on MARG. It copies the MARG launch format, so don't trust its page or pool.</div>;
    if (kind === 'other') {
        return (
            <div className="card empty">
                <h2>Not a MARG token</h2>
                <p>This address is not a token launched on MARG. You can still trade listed jettons on <Link to="/swap">Swap</Link>.</p>
            </div>
        );
    }
    return <Suspense fallback={<div className="card skeleton tall" />}><DexTokenPage key={address.toRawString()} address={address} /></Suspense>;
}
