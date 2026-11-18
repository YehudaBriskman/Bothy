/**
 * The console views the site shows, written out as static HTML.
 *
 * Each function below is the static counterpart of a console component and keeps its element structure and class
 * names, so the console's own stylesheet (scoped under `.console-frame` by scripts/render-console.mjs) dresses it:
 *
 *   renderServices  <-  components/ServiceTable.tsx, ServiceRow.tsx, lib/icons.tsx (StatusIcon), lib/links.ts
 *   renderHealth    <-  components/control-home/HealthStrip.tsx, parts.tsx (ToneIcon), pages/control/ControlHome.tsx
 *   renderFiles     <-  pages/files/Reader.tsx, DocIndex.tsx, FileView.tsx, md.tsx
 *   renderModules   <-  cli/internal/install/module.go (`bothy module list` is a command, not a console screen)
 *
 * What a static picture cannot do, it does not pretend to: rows are not links, tiles are not links and tree rows are
 * not buttons (they are the same classes on inert elements), there is no sort control because ServiceTable has none,
 * and nothing here is live. console.test.ts holds the structure and the class names against the product's source.
 *
 * Direction follows what a value IS (the data-display rule): machine strings (ports, images, paths, hashes, hosts)
 * are `dir="ltr"`; text a person typed (names, authors, commit subjects) is `<bdi>`; a phrase that merely contains a
 * digit is left alone. The whole frame is also `dir="ltr"`, because the console is English and left to right.
 */

import { icon, type IconName } from './icons.ts';
import type {
  FilesFixture,
  HealthFixture,
  HealthTile,
  ModulesFixture,
  ServiceNode,
  ServicesFixture,
  Status,
  Tone,
  TreeFile,
} from './types.ts';

/**
 * Product classes the site stylesheet also uses (`.page`, `.page-head`), written here under another name. The
 * generated CSS renames them the same way, so the product's rules apply and the site's cannot.
 */
export const CLASS_ALIAS: Record<string, string> = { page: 'cx-page', 'page-head': 'cx-page-head' };

export function esc(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
}

/** One placeholder for "no value", everywhere: an em dash with a name a screen reader can say. */
export const EMPTY = '<span class="cx-empty" role="img" aria-label="No value">—</span>';

const orEmpty = (s: string | null | undefined): string => (s ? esc(s) : EMPTY);

// ── lib/icons.tsx ─────────────────────────────────────────────────────────

/** STATUS_ICON, STATUS_VAR and STATUS_LABEL of lib/icons.tsx. */
export const STATUS: Record<Status, { glyph: IconName; token: string; label: string }> = {
  up: { glyph: 'circle-check', token: '--st-up-fg', label: 'Up' },
  starting: { glyph: 'circle-help', token: '--st-warn-fg', label: 'Starting' },
  down: { glyph: 'circle-x', token: '--st-down-fg', label: 'Down' },
  stopped: { glyph: 'circle-pause', token: '--st-off-fg', label: 'Stopped' },
  done: { glyph: 'check-check', token: '--st-up-fg', label: 'Done' },
  dormant: { glyph: 'circle-pause', token: '--st-off-fg', label: 'Dormant' },
  unknown: { glyph: 'circle-help', token: '--st-unknown-fg', label: 'Unknown' },
};

/** The status glyph with its word: form and words, never colour alone. */
function statusIcon(status: Status, title: string): string {
  const s = STATUS[status];
  return `<span class="si si-${status}" style="color:var(${s.token})" title="${esc(title)}">${icon(s.glyph, 'md', '', 1.4)}<span class="si-label">${s.label}</span></span>`;
}

/** The slice of IMAGE_ICONS / NAME_ICONS the example services need, in the product's order and with its glyphs. */
const IMAGE_ICONS: [string, IconName][] = [
  ['nginx', 'globe'],
  ['postgres', 'database'],
  ['redis', 'memory-stick'],
  ['wiki', 'book-open'],
];

function serviceGlyph(n: ServiceNode): IconName {
  const img = (n.container?.image ?? '').toLowerCase();
  if (img) for (const [k, g] of IMAGE_ICONS) if (img.includes(k)) return g;
  const hay = `${n.name} ${n.host ?? ''}`.toLowerCase();
  for (const [k, g] of IMAGE_ICONS) if (hay.includes(k)) return g;
  return 'box';
}

// ── lib/links.ts ──────────────────────────────────────────────────────────

/** kindLabelOf. */
function kindLabel(n: ServiceNode): { label: string; bad: boolean; hint: string } {
  if (n.route?.provider === 'file') {
    return {
      label: 'host process',
      bad: false,
      hint: 'Runs on the host, reached through the edge. Expect 502 when it is not running.',
    };
  }
  if (n.kind === 'orphan-route') {
    return {
      label: 'no container',
      bad: true,
      hint: 'Traefik routes this name, but nothing answers on devnet - it may have stopped.',
    };
  }
  if (n.kind === 'unrouted') {
    return { label: 'unrouted', bad: false, hint: 'Publishes a host port but has no edge route.' };
  }
  return { label: 'routed', bad: false, hint: 'Routed through the edge by hostname.' };
}

/** nodeSub: the line under a name. */
function nodeSub(n: ServiceNode): string {
  return n.host || n.ports.map((p) => `:${p.hostPort}`).join(' ') || n.container?.name || n.group;
}

/** unknownReason. */
function unknownReason(n: ServiceNode): string | null {
  if (n.status !== 'unknown') return null;
  if (n.route?.provider === 'file') {
    return 'No container to ask. Open it to see whether the process is running.';
  }
  return 'No container matched this route on devnet.';
}

// ── Services ──────────────────────────────────────────────────────────────

/** The column headings of ServiceTable, in order. An empty text is an unlabelled control column with an aria-label. */
export const SERVICE_COLUMNS: { text: string; aria?: string; cls?: string }[] = [
  { text: 'Service' },
  { text: 'Status' },
  { text: 'Group' },
  { text: 'Kind' },
  { text: 'Ports' },
  { text: 'Image' },
  { text: '', aria: 'Actions', cls: 'svc-th-act' },
  { text: '', aria: 'Open' },
];

function serviceRow(n: ServiceNode): string {
  const kind = kindLabel(n);
  const ports = n.ports.map((p) => p.hostPort).join(', ');
  const title = n.container?.statusText || unknownReason(n) || STATUS[n.status].label;
  const open = n.browsable && n.url ? `<span class="cx-open">${icon('external-link', 'md')}</span>` : '';
  return [
    '<tr class="svc-tr">',
    `<td class="svc-td-name"><span class="svc-td-link"><span class="ico sm">${icon(serviceGlyph(n), 'md')}</span><span class="svc-td-text"><span class="nm-text"><bdi>${esc(n.name)}</bdi></span><span class="pt" dir="ltr" translate="no">${esc(nodeSub(n))}</span></span></span></td>`,
    `<td data-label="Status">${statusIcon(n.status, title)}</td>`,
    `<td data-label="Group"><bdi>${esc(n.groupTitle)}</bdi></td>`,
    `<td data-label="Kind"><span class="tag${kind.bad ? ' bad' : ''}" title="${esc(kind.hint)}">${kind.label}</span></td>`,
    `<td class="mono" data-label="Ports" dir="ltr" translate="no">${orEmpty(ports)}</td>`,
    `<td class="mono svc-td-img" data-label="Image" dir="ltr" translate="no">${orEmpty(n.container?.image)}</td>`,
    '<td class="svc-td-act"></td>',
    `<td class="svc-td-open">${open}</td>`,
    '</tr>',
  ].join('');
}

/** ServiceTable inside the Services page's head. */
export function renderServices(f: ServicesFixture): string {
  const head = SERVICE_COLUMNS.map((c) =>
    c.aria ? `<th${c.cls ? ` class="${c.cls}"` : ''} aria-label="${c.aria}"></th>` : `<th>${c.text}</th>`,
  ).join('');
  return [
    '<div class="cx-page services-page">',
    '<div class="cx-page-head"><div>',
    '<h1 role="heading" aria-level="3">Services</h1>',
    `<p class="page-sub"><b class="tnum">${f.nodes.length}</b> of ${f.nodes.length}</p>`,
    '</div></div>',
    '<div class="tbl-wrap scroll-shade" tabindex="0" role="region" aria-label="Services">',
    '<table class="tbl as-cards svc-tbl">',
    '<colgroup><col /><col class="svc-col-status" /><col class="svc-col-group" /><col class="svc-col-kind" /><col class="svc-col-ports" /><col /><col class="svc-col-act" /><col class="svc-col-open" /></colgroup>',
    `<thead><tr>${head}</tr></thead>`,
    `<tbody>${f.nodes.map(serviceRow).join('')}</tbody>`,
    '</table></div></div>',
  ].join('');
}

// ── Health strip ──────────────────────────────────────────────────────────

/** parts.tsx TONE: glyph and default word per tone. */
export const TONE: Record<Tone, { glyph: IconName; word: string }> = {
  ok: { glyph: 'circle-check', word: 'OK' },
  warn: { glyph: 'circle-alert', word: 'Needs a look' },
  bad: { glyph: 'circle-x', word: 'Fault' },
  off: { glyph: 'circle-pause', word: 'Off' },
  unknown: { glyph: 'circle-help', word: 'Unknown' },
};

function tile(t: HealthTile): string {
  const value =
    'text' in t.value
      ? esc(t.value.text)
      : `<span class="ch-num">${esc(t.value.num)}</span><span class="ch-of">${esc(t.value.of)}</span>`;
  return [
    '<li>',
    `<div class="ch-tile" data-tone="${t.tone}">`,
    `<span class="ch-tile-top"><span class="eyebrow">${esc(t.label)}</span>`,
    `<span class="ch-tone" data-tone="${t.tone}">${icon(TONE[t.tone].glyph, 'sm')}<span class="sr-only">${esc(t.toneLabel)}</span></span></span>`,
    `<span class="ch-tile-value">${value}</span>`,
    `<span class="ch-tile-sub">${esc(t.sub)}</span>`,
    '</div></li>',
  ].join('');
}

/** HealthStrip inside the Control landing's head. */
export function renderHealth(f: HealthFixture): string {
  return [
    '<div class="cx-page control-page ch">',
    '<div class="cx-page-head ch-head"><div><h1 role="heading" aria-level="3">Control</h1></div>',
    '<div class="ch-head-aside"><span class="ch-asof">as of 12:00</span></div></div>',
    '<section class="ch-health" aria-labelledby="cx-health-h">',
    '<h2 id="cx-health-h" class="sr-only">Health</h2>',
    `<ul class="ch-strip">${f.tiles.map(tile).join('')}</ul>`,
    '</section></div>',
  ].join('');
}

// ── Files ─────────────────────────────────────────────────────────────────

const baseName = (p: string): string => p.slice(p.lastIndexOf('/') + 1);
const dirName = (p: string): string => (p.includes('/') ? p.slice(0, p.lastIndexOf('/') + 1) : '');
const isDir = (e: TreeFile): boolean => e.dir === true;

/** titles.ts, in the small: a document is called what its file is called, prettified. */
export function titleOf(path: string): string {
  const stem = baseName(path).replace(/\.[^.]+$/, '');
  if (stem === stem.toUpperCase()) return stem;
  const words = stem.replace(/[-_]+/g, ' ');
  return words.charAt(0).toUpperCase() + words.slice(1);
}

/** lib/files.ts fmtBytes. */
export function fmtBytes(n: number): string {
  if (n < 1024) return `${n} B`;
  if (n < 1024 * 1024) return `${(n / 1024).toFixed(n < 10240 ? 1 : 0)} KB`;
  return `${(n / (1024 * 1024)).toFixed(1)} MB`;
}

function relDays(from: string, asOf: string): string {
  const days = Math.max(0, Math.round((Date.parse(asOf) - Date.parse(from)) / 86_400_000));
  return days === 0 ? 'today' : days === 1 ? 'yesterday' : `${days} days ago`;
}

function treeRows(f: FilesFixture, parent: string, depth: number): string {
  const kids = f.tree.filter((e) => dirName(e.path) === (parent ? `${parent}/` : '') && e.path !== parent);
  const dirs = kids.filter(isDir).sort((a, b) => baseName(a.path).localeCompare(baseName(b.path), 'en'));
  const files = kids.filter((e) => !isDir(e)).sort((a, b) => baseName(a.path).localeCompare(baseName(b.path), 'en'));
  const pad = `style="padding-inline-start:calc(var(--sp-2) + ${depth} * var(--sp-3))"`;
  const out: string[] = ['<ul class="rd-list">'];
  for (const d of dirs) {
    const open = f.open.includes(d.path);
    const n = f.tree.filter((e) => dirName(e.path) === `${d.path}/`).length;
    out.push(
      '<li class="rd-li">',
      `<span class="rd-dir" ${pad} title="${esc(d.path)}">${icon('chevron-right', 'xs', `chev rd-chev${open ? ' open' : ''}`)}${icon(open ? 'folder-open' : 'folder', 'sm', 'rd-dir-ico')}<span class="rd-dir-name" dir="ltr" translate="no">${esc(baseName(d.path))}</span>${open ? `<span class="rd-dir-n tnum">${n}</span>` : ''}</span>`,
      open ? treeRows(f, d.path, depth + 1) : '',
      '</li>',
    );
  }
  for (const e of files) {
    const on = e.path === f.file.path;
    const label = titleOf(e.path);
    out.push(
      '<li class="rd-li">',
      `<span class="rd-doc${on ? ' on' : ''}" ${pad}${on ? ' aria-current="true"' : ''} title="${esc(`${f.file.root}/${e.path}${e.size != null ? ` · ${fmtBytes(e.size)}` : ''}`)}">${icon('file-text', 'sm', 'rd-doc-ico')}<span class="rd-doc-text"><span class="rd-doc-title"><bdi>${esc(label)}</bdi></span></span></span>`,
      '</li>',
    );
  }
  out.push('</ul>');
  return out.join('');
}

// md.tsx, in the small: headings, paragraphs, lists, fences, inline code and bold. Headings shift down one level
// (the shell owns the document title) and, here, one more: the page's own outline stops at the frame's heading.
function inlineMd(s: string): string {
  return esc(s)
    .replace(/`([^`]+)`/g, '<code class="md-code">$1</code>')
    .replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>');
}

export function renderMd(src: string): string {
  const lines = src.split('\n');
  const out: string[] = [];
  let i = 0;
  while (i < lines.length) {
    const line = lines[i] ?? '';
    const head = /^(#{1,6})\s+(.*)$/.exec(line);
    const fence = /^```(\w*)\s*$/.exec(line);
    if (!line.trim()) {
      i++;
    } else if (head) {
      const lvl = (head[1] ?? '#').length;
      const tag = `h${Math.min(lvl + 1, 6)}`;
      out.push(
        `<${tag} class="md-h md-h${lvl}" role="heading" aria-level="${Math.min(lvl + 3, 6)}">${inlineMd(head[2] ?? '')}</${tag}>`,
      );
      i++;
    } else if (fence) {
      const buf: string[] = [];
      i++;
      while (i < lines.length && !/^```/.test(lines[i] ?? '')) buf.push(lines[i++] ?? '');
      i++;
      out.push(
        `<pre class="md-pre scroll-shade" tabindex="0" role="region" aria-label="Code example" dir="ltr" translate="no">${fence[1] ? `<span class="md-lang">${esc(fence[1])}</span>` : ''}<code>${esc(buf.join('\n'))}</code></pre>`,
      );
    } else if (/^[-*]\s+/.test(line)) {
      const items: string[] = [];
      while (i < lines.length && /^[-*]\s+/.test(lines[i] ?? ''))
        items.push((lines[i++] ?? '').replace(/^[-*]\s+/, ''));
      out.push(`<ul class="md-list">${items.map((t) => `<li>${inlineMd(t)}</li>`).join('')}</ul>`);
    } else {
      const buf: string[] = [];
      while (i < lines.length && (lines[i] ?? '').trim() && !/^(#{1,6}\s|```|[-*]\s)/.test(lines[i] ?? ''))
        buf.push((lines[i++] ?? '').trim());
      out.push(`<p class="md-p">${inlineMd(buf.join(' '))}</p>`);
    }
  }
  return out.join('');
}

/** The reader: the document index beside one rendered document and its provenance line. */
export function renderFiles(f: FilesFixture): string {
  const root = f.roots.find((r) => r.key === f.file.root);
  if (!root) throw new Error('files fixture: the open file names a root that is not in roots');
  const total = f.tree.filter((e) => !isDir(e)).length;
  const last = f.file.history[0];
  const path = f.file.path;
  const prov = last
    ? `<p class="rd-prov">${icon('git-commit', 'sm')}<span class="rd-prov-t">Last changed <b>${relDays(last.date, f.asOf)}</b> by <bdi>${esc(last.author)}</bdi> - <bdi>${esc(last.subject)}</bdi></span><span class="rd-sha mono" dir="ltr" translate="no">${esc(last.sha.slice(0, 7))}</span></p>`
    : '';
  return [
    '<div class="bothy-files bothy-read" data-pane="doc">',
    '<div class="rd-grid">',
    '<aside class="rd-side" aria-label="Documents"><div class="rd-index">',
    '<div class="rd-index-h"><span class="rd-index-title">Documents</span></div>',
    `<section class="rd-root" aria-label="${esc(root.label || root.key)}">`,
    `<h3 class="rd-root-h"><span class="rd-root-btn">${icon('chevron-right', 'xs', 'chev rd-chev open')}<span class="rd-root-name mono" dir="ltr" translate="no">${esc(root.key)}</span><span class="rd-root-n tnum">${total}</span></span></h3>`,
    treeRows(f, '', 0),
    '</section></div></aside>',
    '<div class="rd-main" role="region" aria-label="Document">',
    `<header class="rd-head"><div class="rd-head-row"><p class="rd-crumb mono" dir="ltr" translate="no">${esc(f.file.root)}/${esc(dirName(path))}<b>${esc(baseName(path))}</b></p></div>${prov}</header>`,
    `<div class="rd-body"><div class="fx-doc"><article class="fx-read md scroll-shade" tabindex="0" aria-label="${esc(baseName(path))} - rendered">${renderMd(f.file.content)}</article></div></div>`,
    '</div>',
    '</div></div>',
  ].join('');
}

// ── Modules (the command line) ────────────────────────────────────────────

/** The column heading and row formats of ModuleList in cli/internal/install/module.go. */
export const MODULE_HEADER = ['MODULE', 'STATE', 'MEMORY', 'NEEDS / WHAT IT IS'] as const;

const padEnd = (s: string, n: number): string => s + ' '.repeat(Math.max(0, n - s.length));
const padStart = (s: string, n: number): string => ' '.repeat(Math.max(0, n - s.length)) + s;

/** `bothy module list` as the command prints it: `%-14s %-10s %8s  %s` and `%-14s %-10s %5d Mi  %s; %s`. */
export function moduleListText(f: ModulesFixture): string {
  const installed = f.modules.filter((m) => m.installed).length;
  const lines: string[] = [
    `mode ${f.mode}, release ${f.example.release}, ${installed} modules installed`,
    '',
    `${padEnd(MODULE_HEADER[0], 14)} ${padEnd(MODULE_HEADER[1], 10)} ${padStart(MODULE_HEADER[2], 8)}  ${MODULE_HEADER[3]}`,
  ];
  for (const m of f.modules) {
    const state = m.installed && m.core ? 'core' : m.installed ? 'installed' : 'available';
    const needs = m.requires.length ? `requires ${m.requires.join(', ')}` : '-';
    lines.push(
      `${padEnd(m.name, 14)} ${padEnd(state, 10)} ${padStart(String(m.memory_mib), 5)} Mi  ${needs}; ${m.description}`,
    );
  }
  lines.push('', "Memory is the sum of the module's container limits (what the budget gate counts).");
  return lines.join('\n');
}

export function renderModules(f: ModulesFixture): string {
  return [
    '<div class="cx-page cx-cli">',
    '<div class="cx-page-head"><div><h1 role="heading" aria-level="3">Modules</h1>',
    '<p class="page-sub">What <code class="mono" dir="ltr" translate="no">bothy module list</code> prints. A command, not a console screen.</p></div></div>',
    '<figure class="cx-term">',
    '<figcaption class="eyebrow">Terminal</figcaption>',
    `<pre class="mono" dir="ltr" translate="no" tabindex="0" role="region" aria-label="bothy module list output"><code><span class="cx-prompt" aria-hidden="true">$ </span>bothy module list\n${esc(moduleListText(f))}</code></pre>`,
    '</figure></div>',
  ].join('');
}
