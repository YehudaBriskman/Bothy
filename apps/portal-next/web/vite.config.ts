import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Same-origin APIs live under /-/api/* in production (Traefik serves them, not
// this app). For local `vite dev` only, proxy them to the live box so the
// dashboard has something to render. The production build never sees this.
//
// THIS POINTED AT the portal UNTIL 2026-08-17, a name whose entire
// configuration was deleted on 2026-08-12 - so `vite dev` had been proxying to
// something that does not resolve for two months. It survived a purge of every
// other the name layer reference because that sweep read prose and this is a config
// value. Grep the deleted thing, not the sentences about it.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/-/api': {
        target: 'http://100.117.176.85',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
