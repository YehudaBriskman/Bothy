// ── what a document is called, without an index ──────────────────────────────
//
// The reader's side panel lists TITLES, not filenames (docs/plans/
// reading-first.md §3). The cheapest title that is right most of the time is the
// filename, prettified: `tailnet-troubleshooting.md` is already "Tailnet
// troubleshooting", because whoever named the file was writing the title.
//
// THE ALTERNATIVE IS DELIBERATELY NOT BUILT YET. The plan's own answer for a
// better title is the document's first heading, read server-side behind a
// `titles=1` parameter on /tree - and it says explicitly: do the filename
// version first, add the parameter only if the titles are wrong often enough to
// notice. This is that first version. Measured against the real roots, it agrees
// with the `# heading` on essentially all of docs/brand (39 files) and all of
// ~/claude-notes, and it is worse on exactly one shape - docs/kb, where the
// heading is the filename PLUS a subtitle ("RUNBOOK - I can't reach the dev
// stack" for runbook-cant-reach.md). That is a subtitle problem, not a wrong
// title, which is why it does not yet justify a second endpoint.
//
// Imports NOTHING, so checks/ can compile and run it on its own.

/** Tokens whose sentence-cased form is visibly wrong, and their display form.
 *
 *  This is the ONLY table here, and it is short because it only has to cover
 *  what is actually in the roots - a general "is this an acronym?" rule does not
 *  exist, and guessing produces `THE` and `AND`. Keys are lowercase; a token is
 *  matched case-insensitively. */
const ACRONYMS: Record<string, string> = {
  api: 'API', cd: 'CD', ci: 'CI', cli: 'CLI', corp: 'CORP', cors: 'CORS',
  cpu: 'CPU', csp: 'CSP', css: 'CSS', db: 'DB', dhcp: 'DHCP', dns: 'DNS',
  dom: 'DOM', faq: 'FAQ', gpu: 'GPU', html: 'HTML', http: 'HTTP',
  https: 'HTTPS', id: 'ID', ide: 'IDE', io: 'IO', ip: 'IP', json: 'JSON',
  jwt: 'JWT', k8s: 'k8s', kb: 'KB', mcp: 'MCP', nic: 'NIC', npm: 'npm',
  os: 'OS', pdf: 'PDF', png: 'PNG', pwa: 'PWA', qa: 'QA', ram: 'RAM',
  scm: 'SCM', sdk: 'SDK', seo: 'SEO', sh: 'SH', sql: 'SQL', ssh: 'SSH',
  sso: 'SSO', ssl: 'SSL', svg: 'SVG', tls: 'TLS', ui: 'UI', url: 'URL',
  ux: 'UX', vpn: 'VPN', wsl: 'WSL', yaml: 'YAML',
};

/** Names that are conventions rather than words. Left exactly as written,
 *  because "Readme" reads as a typo of a filename everybody already knows. */
const KEPT = new Set(['README', 'LICENSE', 'CHANGELOG', 'NOTICE', 'TODO', 'CONTRIBUTING']);

/** A leading ISO date, which is how the incident notes are named. Kept as the
 *  date rather than folded into the sentence - it is the thing those files are
 *  sorted and remembered by, and "2026 08 08 WSL node…" is a worse title than
 *  either half on its own. */
const RE_DATED = /^(\d{4}-\d{2}-\d{2})[-_](.+)$/;

function word(tok: string): string {
  const hit = ACRONYMS[tok.toLowerCase()];
  if (hit) return hit;
  // AN ALL-CAPS TOKEN IS A FILENAME CONVENTION, NOT EMPHASIS. `CODE_OF_CONDUCT`
  // and `ARCHITECTURE` are shouting because that is how a top-level doc is
  // named, and reproducing it in a list of twenty titles shouts at the reader
  // instead. Anything else is left exactly as typed, so a name that already
  // carries its own capitals (`CVOps`, `Thinkpad`) keeps them.
  if (tok.length > 1 && tok === tok.toUpperCase() && /[A-Z]/.test(tok)) return tok.toLowerCase();
  return tok;
}

/** The file's own name, without its extension. Exported because the index shows
 *  it under the title, and a second copy of "strip the extension" is how the two
 *  come to disagree about a file called `a.b.md`. */
export function stemOf(name: string): string {
  const dot = name.lastIndexOf('.');
  return dot > 0 ? name.slice(0, dot) : name;
}

/**
 * A display title for one file, from its path alone. No fetch, no index.
 *
 * @param path root-relative, `docs/kb/access.md`. Only the basename is read;
 *             the folder is shown separately by the index, and folding it in
 *             here would title every README after its directory.
 */
export function titleOf(path: string): string {
  const name = path.slice(path.lastIndexOf('/') + 1);
  const stem = stemOf(name);
  if (KEPT.has(stem.toUpperCase())) return stem.toUpperCase();

  const dated = RE_DATED.exec(stem);
  const body = dated ? dated[2] : stem;

  const words = body.split(/[-_.\s]+/).filter(Boolean).map(word);
  if (!words.length) return stem;
  // Sentence case: the FIRST word gets a capital and the rest keep whatever
  // `word()` decided. Title Case Every Word looks like a headline and disagrees
  // with how the documents themselves are titled ("Shape and elevation",
  // "Data display and tables") - so the list would be shouting a different
  // sentence than the page it opens.
  let out = words.join(' ');
  out = out.charAt(0).toUpperCase() + out.slice(1);
  // A middle dot rather than a dash: the title itself often contains dashes and
  // a second one would read as part of the sentence.
  return dated ? `${dated[1]} · ${out}` : out;
}

/** Extensions the reader treats as PROSE, and orders first. Deliberately small:
 *  the claim being made is "a person reads this end to end", not "this is
 *  text". A .yml is text and nobody reads it for pleasure. */
const PROSE_EXT = new Set(['md', 'markdown', 'mdx', 'rst', 'txt', 'adoc']);

export function isProse(path: string): boolean {
  const dot = path.lastIndexOf('.');
  return dot > 0 && PROSE_EXT.has(path.slice(dot + 1).toLowerCase());
}

/** How a folder is labelled in the index. `''` is the root of the root, which
 *  has no name of its own and is not "the empty folder". */
export function folderLabel(dir: string, root: string): string {
  return dir ? dir.replace(/\/+$/, '') : root;
}
