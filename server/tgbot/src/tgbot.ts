// MARG Telegram bot (@marglolbot): announces new direct launches in TG_LAUNCH_CHAT and posts
// buy alerts in groups that /track a token. Reads the MARG indexer API only; no wallet, no keys.
//
// Env: TG_BOT_TOKEN (EnvironmentFile only, never logged), TG_LAUNCH_CHAT (-100… or @channel,
// optional), INDEXER_URL (default http://127.0.0.1:8811/api/idx), SITE_URL (default
// https://marg.lol), STATE_DIRECTORY (set by systemd StateDirectory=; default ./state),
// TONCENTER_API_KEY (optional, launch tax/vault details), TONCENTER_URL, TG_API_URL, COINGECKO_URL.
import { Bot } from './bot';

const token = process.env.TG_BOT_TOKEN ?? '';
if (!/^\d{5,16}:[A-Za-z0-9_-]{30,64}$/.test(token)) {
    console.error('Set TG_BOT_TOKEN (from @BotFather) in the environment file');
    process.exit(1);
}
const env = (k: string, d: string) => (process.env[k] ?? '').trim() || d;
const launchChat = env('TG_LAUNCH_CHAT', '');

const bot = new Bot({
    botToken: token,
    tgApi: env('TG_API_URL', 'https://api.telegram.org'),
    launchChat: launchChat || null,
    indexerUrl: env('INDEXER_URL', 'http://127.0.0.1:8811/api/idx'),
    siteUrl: env('SITE_URL', 'https://marg.lol').replace(/\/+$/, ''),
    stateDir: (env('STATE_DIRECTORY', './state').split(':')[0]),
    toncenterUrl: env('TONCENTER_URL', 'https://toncenter.com/api/v2'),
    toncenterKey: process.env.TONCENTER_API_KEY || null,
    coingeckoUrl: env('COINGECKO_URL', 'https://api.coingecko.com/api/v3/simple/price'),
    perChatGapMs: 3000,
    globalGapMs: 40,
    pollTimeoutSec: 30,
    launchMaxAgeSec: 6 * 3600,
    log: (s) => console.log(s.split(token).join('***')),
});

process.on('SIGTERM', () => { bot.stop(); process.exit(0); });
process.on('unhandledRejection', (e: any) => console.error('unhandled:', String(e?.message ?? e).split(token).join('***').slice(0, 300)));

bot.start().catch((e) => {
    console.error(String(e?.message ?? e).split(token).join('***').slice(0, 300));
    process.exit(1);
});
