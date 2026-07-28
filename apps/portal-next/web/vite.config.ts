import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

// Same-origin read-only APIs live under /-/api/* in production (Traefik serves
// them, not this app). For local `vite dev` only, proxy them to the live box so
// the dashboard has something to render. The production build never sees this.
export default defineConfig({
  plugins: [react()],
  server: {
    proxy: {
      '/-/api': {
        target: 'http://dev.test',
        changeOrigin: true,
      },
    },
  },
  build: {
    outDir: 'dist',
    sourcemap: false,
  },
});
