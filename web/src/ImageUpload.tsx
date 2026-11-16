import { useRef, useState } from 'react';

const MAX_BYTES = 5 * 1024 * 1024;
const TYPES = ['image/png', 'image/jpeg', 'image/webp', 'image/gif'];

// Uploads the token picture to our server (/api/upload) and reports the public URL.
export function ImageUpload({ value, onChange }: { value: string; onChange: (url: string) => void }) {
    const input = useRef<HTMLInputElement>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [drag, setDrag] = useState(false);

    async function upload(file: File) {
        setError(null);
        if (!TYPES.includes(file.type)) return setError('Use a PNG, JPG, WEBP or GIF image.');
        if (file.size > MAX_BYTES) return setError(`That file is ${(file.size / 1024 / 1024).toFixed(1)} MB. The limit is 5 MB.`);
        setBusy(true);
        try {
            const res = await fetch('/api/upload', { method: 'POST', headers: { 'Content-Type': file.type }, body: file });
            const json = await res.json().catch(() => ({}));
            if (!res.ok) {
                const fallback = res.status === 413 ? 'The limit is 5 MB.'
                    : res.status === 429 || res.status === 503 ? 'Too many uploads, wait a minute.'
                    : `Upload failed (${res.status})`;
                throw new Error(json.error ?? fallback);
            }
            onChange(json.url);
        } catch (e: any) {
            setError(e?.message ?? 'Upload failed');
        } finally {
            setBusy(false);
        }
    }

    return (
        <div className="upload-field">
            <span>Image</span>
            <div
                className={`dropzone ${drag ? 'drag' : ''} ${value ? 'has-image' : ''}`}
                onClick={() => input.current?.click()}
                onDragOver={(e) => { e.preventDefault(); setDrag(true); }}
                onDragLeave={() => setDrag(false)}
                onDrop={(e) => {
                    e.preventDefault();
                    setDrag(false);
                    const f = e.dataTransfer.files?.[0];
                    if (f) upload(f);
                }}
                role="button"
                tabIndex={0}
            >
                {value ? <img src={value} alt="" /> : <div className="dz-icon">🖼</div>}
                <div className="dz-text">
                    <b>{busy ? 'Uploading…' : value ? 'Change image' : 'Upload image'}</b>
                    <span className="hint small">PNG, JPG, WEBP or GIF, up to 5 MB. Square works best.</span>
                </div>
                <input
                    ref={input}
                    type="file"
                    accept={TYPES.join(',')}
                    hidden
                    onChange={(e) => {
                        const f = e.target.files?.[0];
                        if (f) upload(f);
                        e.target.value = '';
                    }}
                />
            </div>
            {error && <span className="upload-error small">{error}</span>}
        </div>
    );
}
