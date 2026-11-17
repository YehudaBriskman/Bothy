import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';

/**
 * One HTML entry: `index.html` is the shell every prerendered page is cut from
 * (scripts/prerender.mjs fills its head and body per route). Vite builds the
 * stylesheet and the small `enhance.ts` script and hashes them.
 *
 * `SITE_BASE` is the path the site is mounted at (default `/`); the same value
 * is read by src/config.ts when the pages are rendered, so asset links and page
 * links agree. A build for a box, which has no public origin and may live under
 * a prefix, is `SITE_ORIGIN= SITE_BASE=/bothy/ npm run build`.
 */
export default defineConfig(() => {
  const raw = process.env.SITE_BASE ?? '/';
  const base = `${raw.startsWith('/') ? raw : `/${raw}`}${raw.endsWith('/') ? '' : '/'}`;
  return {
    base,
    plugins: [react()],
    build: {
      target: 'es2022',
      chunkSizeWarningLimit: 200,
    },
  };
});
