// The stand-in for GET /version.json, used by `vite dev` and nothing else.
//
// lib/version.ts routes here behind `import.meta.env.DEV`, a literal `false`
// after a build. The first answer is the revision this tab "loaded"; every later
// one is the same - unless forced, from the console:
//
//   localStorage['bothy-dev-version'] = 'updated'    later answers name another build
//   localStorage['bothy-dev-version'] = 'silence'    every answer fails (mid-update)
//
// and the banner appears within a few seconds (POLL_MS is short in dev), or at
// once when the tab regains focus. By the CLOCK, not by counting calls: React's
// StrictMode runs the polling effect twice in dev, and a counter would hand the
// "loaded" revision to the aborted first run.

const KEY = 'bothy-dev-version';
const LOADED = '4f1c2a9e7d3b5c8a0e6f1d2b3c4a5e6f7a8b9c0d';
const NEWER = '9e8d7c6b5a4f3e2d1c0b9a8f7e6d5c4b3a2f1e0d';
const T0 = Date.now();

export async function revisionMock(): Promise<string | null> {
  await new Promise((r) => setTimeout(r, 60));
  let forced: string | null = null;
  try { forced = localStorage.getItem(KEY); } catch { /* dev only */ }
  if (forced === 'silence') return null;
  return forced === 'updated' && Date.now() - T0 > 2_500 ? NEWER : LOADED;
}
