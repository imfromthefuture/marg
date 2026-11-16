// Inside Telegram, take over the viewer's own theme colours (themeParams) and paint Telegram's header to match.
type ThemeParams = Partial<Record<
    'bg_color' | 'secondary_bg_color' | 'section_bg_color' | 'text_color' | 'hint_color' | 'link_color' |
    'button_color' | 'button_text_color' | 'destructive_text_color' | 'section_separator_color', string>>;

export function initTelegram() {
    const wa = (window as any).Telegram?.WebApp;
    if (!wa || !wa.initData) return; // plain browser
    wa.ready();
    wa.expand();
    const apply = () => {
        const root = document.documentElement;
        const t: ThemeParams = wa.themeParams ?? {};
        root.classList.add('tg');
        root.dataset.theme = wa.colorScheme === 'dark' ? 'dark' : 'light';
        const set = (name: string, value?: string) => value && root.style.setProperty(name, value);
        set('--bg', t.secondary_bg_color ?? t.bg_color);
        set('--panel', t.section_bg_color ?? t.bg_color);
        set('--panel-2', t.secondary_bg_color);
        set('--text', t.text_color);
        set('--hint', t.hint_color);
        set('--link', t.link_color);
        set('--accent-2', t.link_color);
        set('--accent', t.button_color);
        set('--accent-ink', t.button_text_color);
        set('--red', t.destructive_text_color);
        set('--border', t.section_separator_color);
        const bg = getComputedStyle(root).getPropertyValue('--bg').trim();
        wa.setHeaderColor?.(bg);
        wa.setBackgroundColor?.(bg);
    };
    apply();
    wa.onEvent?.('themeChanged', apply);
}

export const isTelegram = () => !!(window as any).Telegram?.WebApp?.initData;

export function shareUrl(url: string, text: string) {
    return `https://t.me/share/url?url=${encodeURIComponent(url)}&text=${encodeURIComponent(text)}`;
}

// Light by default (the logo's background); dark from the toggle (remembered per browser).
export function initialTheme(): 'light' | 'dark' {
    const set = document.documentElement.dataset.theme;
    if (set === 'light' || set === 'dark') return set;
    let saved: string | null = null;
    try { saved = localStorage.getItem('marg-theme'); } catch { /* storage blocked */ }
    const theme = saved === 'dark' || saved === 'light' ? saved
        : 'light';
    document.documentElement.dataset.theme = theme;
    return theme;
}

export function saveTheme(theme: 'light' | 'dark') {
    document.documentElement.dataset.theme = theme;
    try { localStorage.setItem('marg-theme', theme); } catch { /* storage blocked */ }
}
