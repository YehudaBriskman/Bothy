import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Same-origin APIs live under /-/api/* in production (Traefik serves them, not
// this app). For local `vite dev` only, proxy them to the live box so the
// dashboard has something to render. The production build never sees this.
//
// THIS POINTED AT the portal UNTIL 2026-08-17, a name whose entire
// configuration was deleted on 2026-08-12 - so `vite dev` had been proxying to
// something that does not resolve for two months. It survived a purge of every
// other name-layer reference because that sweep read prose and this is a config
// value. Grep the deleted thing, not the sentences about it.
// `preview` gets the SAME proxy as `server`, and that is not symmetry for its own
// sake: on this box `vite dev` never becomes interactive (see the notes on the
// headless Chromium's frame clock), so `vite preview` over a real build is the
// only way anybody looks at a page before shipping it. Without this, every
// data-backed block in preview renders its refusal state and a screenshot proves
// only that the refusal state is pretty. `preview` serves `dist/`, so this
// changes nothing about the build or what is deployed.
const API_PROXY = {
  '/-/api': {
    target: 'http://100.117.176.85',
    changeOrigin: true,
  },
};

export default defineConfig({
  plugins: [react()],
  server: { proxy: API_PROXY },
  preview: { proxy: API_PROXY },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
