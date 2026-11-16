import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { fileURLToPath } from 'node:url';

// Dev: uploads and the indexer go to the live VPS unless API_PROXY points elsewhere.
const API = process.env.API_PROXY ?? 'https://marg.lol';

export default defineConfig({
    plugins: [react()],
    // Contract wrappers are generated into ../build by the Tact compiler.
    server: {
        fs: { allow: ['..'] },
        proxy: {
            '/api': { target: API, changeOrigin: true },
            '/u': { target: 'https://marg.lol', changeOrigin: true },
        },
    },
    define: { global: 'globalThis' },
    // The wrappers in ../build, ../launch/build and ../dex/v2/build import @ton/core from the repo
    // root; one copy is needed, because Address checks use instanceof.
    resolve: { alias: { '@ton/core': fileURLToPath(new URL('./node_modules/@ton/core', import.meta.url)) } },
});
