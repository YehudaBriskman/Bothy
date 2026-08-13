// BothyFiles - the client for /-/api/files.
//
// Same-origin, no CORS, no keys (Traefik serves it beside the SPA, exactly like
// the read-only /-/api/traefik and /-/api/docker planes in api.ts).
//
// EVERY endpoint needs a session, not just the write. The roots widened from two
// markdown trees to the box itself - the stacks repo, ~/claude-notes, ~/projects
// - and that surface holds real secrets (19 values in .env, a TLS private key
// under ~/projects), so `viewer` is required to read and `editor` to save. The
// old "read is open" design is dead; a 401 can now come back from any call.
//
// Because of that, 401 is modelled as a FIRST-CLASS RESULT rather than a
// failure: a signed-out visitor is the ordinary case, not a broken page. Reads
// reject with an ApiError carrying `.status`, so a caller can branch on 401
// without string-matching a message; `write` returns a discriminated outcome in
// which "sign in first" and "you may read this but not edit it" are two of the
// listed answers.
//
// The 401 is emitted by oauth2-proxy, NOT by the files service, so its body is
// `text/plain` ("Unauthorized"), not JSON. Anything here that parses a failure
// body has to survive that.

const BASE = '/-/api/files';
const TIMEOUT = 20_000;

export interface FileRoot {
  key: string;
  writableSuffixes?: string[];
  label?: string;
  readOnly?: boolean;
}

// `dir`, `lang` and `readable` are the widened backend's fields and are OPTIONAL
// here on purpose: this page ships before they do, so every consumer treats
// their absence as "unknown" and falls back (directories are inferred from the
// paths, language from the extension, readability assumed true). Typing them as
// required would have made the page render nothing the moment it met the older
// response, which is the failure mode a portal must not have.
export interface TreeFile {
  path: string;
  size: number;
  mtime: number;
  writable: boolean;
  // MEASURED, not assumed: the live service sends `dir` as the entry's PARENT
  // PATH (a string, "" at the root), while the spec this page was written to
  // called it a boolean "this entry is a directory". Both are accepted - `true`
  // marks a directory, a string is ignored as redundant with the path - so the
  // tree is right either way and cannot be broken by the field settling on one
  // meaning later. Inferring directories from the path separators is the
  // fallback and is what actually runs today.
  dir?: boolean | string;
  lang?: string | null;
  readable?: boolean;
}

export interface Commit {
  sha: string;
  author: string;
  date: string;
  subject: string;
}

export interface FileRead {
  root: string;
  path: string;
  content: string;
  size: number;
  mtime: number;
  writable: boolean;
  history: Commit[];
  binary?: boolean;
  lang?: string | null;
}

export interface WriteResult {
  ok: boolean;
  path: string;
  committed: boolean;
  unchanged: boolean;
  sha?: string;
  author?: string;
  message?: string;
  history: Commit[];
}

// Carries the HTTP status, which is the whole point: the page has to tell "you
// are signed out" (401 - an invitation) apart from "the service is broken" (5xx
// - an error) apart from "this path is denied" (403 - a fact about the file),
// and sniffing those out of a message string is how that goes wrong.
export class ApiError extends Error {
  status: number;
  constructor(status: number, message: string) {
    super(message);
    this.name = 'ApiError';
    this.status = status;
  }
}

export function isAuthError(e: unknown): boolean {
  return e instanceof ApiError && e.status === 401;
}

async function getJSON<T>(url: string, signal?: AbortSignal): Promise<T> {
  const ac = new AbortController();
  // The tree can now be thousands of entries over an SSD the collector is also
  // walking, so the read timeout is generous. It exists to stop a hung socket
  // pinning the panel in its skeleton forever, not to police latency.
  const t = setTimeout(() => ac.abort(), TIMEOUT);
  // One abort signal from two sources: the caller's (a superseded request) and
  // the timeout's. Without the forward the timeout would leak a hung fetch.
  signal?.addEventListener('abort', () => ac.abort(), { once: true });
  try {
    const r = await fetch(url, { signal: ac.signal, headers: { Accept: 'application/json' } });
    if (!r.ok) throw new ApiError(r.status, await errorText(r, `${r.status} ${r.statusText}`));
    return (await r.json()) as T;
  } finally {
    clearTimeout(t);
  }
}

export function listRoots(signal?: AbortSignal): Promise<{ roots: FileRoot[] }> {
  return getJSON(`${BASE}/roots`, signal);
}

export function listTree(root: string, signal?: AbortSignal): Promise<{ root: string; files: TreeFile[] }> {
  return getJSON(`${BASE}/tree?root=${encodeURIComponent(root)}`, signal);
}

export function readFile(root: string, path: string, signal?: AbortSignal): Promise<FileRead> {
  return getJSON(`${BASE}/read?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, signal);
}

export function fileHistory(root: string, path: string, signal?: AbortSignal): Promise<{ path: string; history: Commit[] }> {
  return getJSON(`${BASE}/history?root=${encodeURIComponent(root)}&path=${encodeURIComponent(path)}`, signal);
}

// Where the browser sends anyone who needs a session - now the entry point for
// BROWSING, not just for saving.
//
// RELATIVE, not location.href: oauth2-proxy refuses an absolute `rd` unless the
// host is whitelisted, and the hostname here is whatever address the reader
// happened to use (tailnet IP, MagicDNS name, localhost). A leading-slash path is
// always accepted, and it carries the hash - which is where this SPA's route and
// its ?root/?path live, so the sign-in lands back on the same file.
export function signInUrl(): string {
  return `/oauth2/sign_in?rd=${encodeURIComponent(location.pathname + location.search + location.hash)}`;
}

// The outcomes a save can have. `auth` and `unchanged` are deliberately NOT
// errors: a signed-out reader hitting Save is the documented flow, and a save
// with nothing to commit succeeded - it just had no work to do.
export type SaveOutcome =
  | { kind: 'saved'; res: WriteResult }
  | { kind: 'unchanged'; res: WriteResult }
  | { kind: 'auth' }
  | { kind: 'refused'; message: string }
  | { kind: 'too-large'; message: string }
  | { kind: 'error'; message: string };

// Best-effort read of an error body. The service writes `{"error": "..."}` and
// those strings are written to be shown to a human, so they are surfaced
// verbatim; oauth2-proxy and nginx write plain text, so a JSON parse failing is
// normal rather than exceptional.
async function errorText(r: Response, fallback: string): Promise<string> {
  try {
    const body = await r.text();
    if (!body) return fallback;
    try {
      const j = JSON.parse(body) as { error?: string; message?: string };
      return j.error || j.message || fallback;
    } catch {
      const flat = body.trim().replace(/\s+/g, ' ');
      return flat.length > 200 ? fallback : flat || fallback;
    }
  } catch {
    return fallback;
  }
}

export async function writeFile(
  root: string,
  path: string,
  content: string,
  message: string,
): Promise<SaveOutcome> {
  let r: Response;
  try {
    r = await fetch(`${BASE}/write`, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Accept: 'application/json' },
      body: JSON.stringify({ root, path, content, message }),
    });
  } catch (e) {
    return { kind: 'error', message: e instanceof Error ? e.message : 'the request never left the browser' };
  }

  if (r.status === 401) return { kind: 'auth' };
  // 403 covers two different facts and the browser cannot tell them apart: the
  // path is denied (traversal, wrong extension, a denied dir) or the session has
  // `viewer` but not `editor`. The service writes both as a sentence meant for a
  // human, so the sentence is what gets shown - and the fallback is worded to be
  // true either way.
  if (r.status === 403) {
    return { kind: 'refused', message: await errorText(r, 'you can read this file but not save it') };
  }
  if (r.status === 413) return { kind: 'too-large', message: await errorText(r, 'the file is over the 1 MB limit') };
  if (!r.ok) return { kind: 'error', message: await errorText(r, `${r.status} ${r.statusText}`) };

  let res: WriteResult;
  try {
    res = (await r.json()) as WriteResult;
  } catch {
    return { kind: 'error', message: 'the save returned a body this page could not read' };
  }
  if (!res.ok) return { kind: 'error', message: 'the server reported the save did not complete' };
  return res.unchanged ? { kind: 'unchanged', res } : { kind: 'saved', res };
}

// ── formatting ───────────────────────────────────────────────────────────────

// Relative dates, coarse on purpose: a commit list is scanned for "recent /
// not recent", and "3 weeks ago" answers that better than a timestamp. The exact
// date stays available as the row's tooltip, so nothing is lost.
export function relDate(iso: string): string {
  const t = Date.parse(iso);
  if (Number.isNaN(t)) return iso;
  const secs = Math.round((Date.now() - t) / 1000);
  if (secs < 45) return 'just now';
  const mins = Math.round(secs / 60);
  if (mins < 60) return `${mins}m ago`;
  const hrs = Math.round(mins / 60);
  if (hrs < 24) return `${hrs}h ago`;
  const days = Math.round(hrs / 24);
  if (days < 7) return `${days}d ago`;
  const wks = Math.round(days / 7);
  if (wks < 5) return `${wks}w ago`;
  const mons = Math.round(days / 30);
  if (mons < 12) return `${mons}mo ago`;
  return `${Math.round(days / 365)}y ago`;
}

export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

// The tree serves the whole root, including PNGs. `read` happily returns those
// as lossily-decoded text (U+FFFD everywhere), which would render as pages of
// mojibake and, worse, could be saved back as that mojibake if the file were
// ever writable. Detecting it here means the page can say "binary" instead.
export function looksBinary(content: string): boolean {
  if (!content) return false;
  const head = content.slice(0, 4096);
  if (head.includes('\u0000')) return true;
  let bad = 0;
  for (const ch of head) if (ch === '\ufffd') bad++;
  return bad > head.length * 0.02;
}

// ── language ─────────────────────────────────────────────────────────────────
//
// The backend is growing a `lang` hint; until it arrives (and for anything it
// does not label) the extension is the answer. Only the languages the
// highlighter actually knows are named here - claiming a language it cannot
// colour would be worse than admitting none.
const EXT_LANG: Record<string, string> = {
  ts: 'ts', tsx: 'ts', mts: 'ts', cts: 'ts',
  js: 'ts', jsx: 'ts', mjs: 'ts', cjs: 'ts',
  json: 'json', jsonc: 'json',
  py: 'py', pyi: 'py',
  sh: 'sh', bash: 'sh', zsh: 'sh', env: 'sh',
  yml: 'yml', yaml: 'yml',
  toml: 'yml', ini: 'yml', cfg: 'yml', conf: 'yml',
  md: 'md', markdown: 'md',
};

// Named files with no extension, or whose extension lies about them.
const NAME_LANG: [RegExp, string][] = [
  [/^dockerfile(\..+)?$/i, 'docker'],
  [/^containerfile$/i, 'docker'],
  [/^\.env(\..+)?$/i, 'sh'],
  [/^(makefile|justfile)$/i, 'sh'],
  [/^\.(bashrc|zshrc|profile|bash_profile)$/i, 'sh'],
  [/^(docker-)?compose\.ya?ml$/i, 'yml'],
];

// The backend's own names for the same languages. It says `bash` and `yaml`
// where the highlighter's tables say `sh` and `yml`; without this the hint is
// honoured and then matches no rule set, so a labelled file highlights WORSE
// than an unlabelled one. Measured against the live /tree response.
const LANG_ALIAS: Record<string, string> = {
  bash: 'sh', shell: 'sh', zsh: 'sh', dotenv: 'sh',
  yaml: 'yml',
  javascript: 'ts', typescript: 'ts', tsx: 'ts', jsx: 'ts',
  python: 'py',
  markdown: 'md',
  dockerfile: 'docker',
  toml: 'yml', ini: 'yml',
};

export function langFor(path: string, hint?: string | null): string {
  if (hint) {
    const h = hint.toLowerCase();
    return LANG_ALIAS[h] ?? h;
  }
  const name = path.slice(path.lastIndexOf('/') + 1);
  for (const [re, lang] of NAME_LANG) if (re.test(name)) return lang;
  const dot = name.lastIndexOf('.');
  if (dot <= 0) return '';
  return EXT_LANG[name.slice(dot + 1).toLowerCase()] ?? '';
}
