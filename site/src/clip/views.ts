import { clip as c, views as v } from '../i18n/clip-en.ts';
import { MODULES, SERVICES, TILES } from './example.ts';

/**
 * The window's pages, as small HTML strings, drawn from the example fixtures (fixtures/console/*.json, which
 * console.test.ts holds to the product's own types). Nothing here is interactive: the window is a picture. The first
 * frame (poster) is page(false), rendered into the HTML; the player swaps in page(true) when it mounts.
 * Markup hooks: data-h (a thing the pointer can rest on), data-when="key:a,b" (shown while the state has that value),
 * data-at="a-b" (shown between two times), data-type/start/dur (typed), data-draw="a,b" (drawn between two times).
 */

const CHIP: Record<string, string> = { up: 'ok', starting: 'warn', unknown: 'warn', stopped: 'off', down: 'bad' };
const chip = (cls: string, text: string, when = '', on = false) =>
  `<span class="nv-chip is-${cls}${when ? ' sw' : ''}${on ? ' on' : ''}"${when ? ` data-when="${when}"` : ''}><i></i>${text}</span>`;
const typed = (cls: string, f: string, text: string, start: number, dur: number, ph = '', until = 0) =>
  `<span class="cv-field ${cls}" data-f="${f}" data-type="${text}" data-start="${start}" data-dur="${dur}"${until ? ` data-until="${until}"` : ''}${ph ? ` data-ph="${ph}"` : ''}></span>`;
const btn = (h: string, text: string, cls = '') => `<span class="cv-btn ${cls}" data-h="${h}">${text}</span>`;
const sw = (when: string, inner: string, cls = '') => `<span class="sw ${cls}" data-when="${when}">${inner}</span>`;
const toast = (a: number, b: number, text: string) => `<div class="cv-toast" data-at="${a}-${b}"><i></i>${text}</div>`;

const WIKI = SERVICES.find((n) => n.id === 'wiki')!;
const ports = (n: (typeof SERVICES)[number]) => (n.port ? String(n.port) : '-');

function servicesView(rich: boolean): string {
  const rows = SERVICES.map((n) => {
    const wiki = n.id === 'wiki';
    const state = wiki
      ? `<span class="nv-flip">${chip('warn', 'starting', 'svc:starting,restart', true)}${chip('ok', 'up', 'svc:up,up2')}</span>`
      : chip(CHIP[n.status] ?? 'off', n.status);
    return `<tr data-st="${n.status}"${wiki ? ' class="r-wiki" data-h="row-wiki"' : ''}><td>${n.name}</td><td>${state}</td><td class="nv-n">${ports(n)}</td><td></td></tr>`;
  });
  if (rich)
    rows.push(
      `<tr data-st="up" class="r-new" data-when="g:1"><td>Grafana <span class="nv-dim">(${c.example})</span></td><td>${chip('ok', 'up')}</td><td class="nv-n">3000</td><td class="nv-act">${btn('open-grafana', c.open, 'sm')}</td></tr>`,
    );
  const tool = rich
    ? `<div class="cv-tool">${btn('refresh', `<b class="cv-ic">&#8635;</b> ${c.refresh}`)}<span class="cv-chips"><span data-h="chip-running" class="cv-chipb" data-when="chip:running" >${c.running}</span><span class="cv-chipb" data-h="chip-stopped">${c.stopped}</span><span class="cv-chipb" data-h="chip-all" data-when="chip:all">${c.all}</span></span><span class="cv-search" data-h="search">${typed('f-s', 'search', 'wiki', 6.4, 0.9, v.filter, 40.6)}</span></div>`
    : `<div class="cv-tool"><span class="cv-btn"><b class="cv-ic">&#8635;</b> ${c.refresh}</span><span class="cv-chips"><span class="cv-chipb on">${c.all}</span></span><span class="cv-search"><span class="cv-field f-s" data-ph="${v.filter}"></span></span></div>`;
  return `${tool}<table class="nv-t"><thead><tr><th scope="col">${v.th.service}</th><th scope="col">${v.th.state}</th><th scope="col" class="nv-n">${c.ports}</th><th></th></tr></thead><tbody>${rows.join('')}</tbody></table>${rich ? drawer() : ''}`;
}

const LOGS: [number, string, string, string, string][] = [
  [19.8, '12:00:01', 'info', 'listening on :8090', ''],
  [20.3, '12:00:02', 'info', 'connected to notes-db', ''],
  [20.8, '12:00:04', 'info', 'GET /  200', ''],
  [21.3, '12:00:05', 'info', 'GET /search  200', ''],
  [21.8, '12:00:07', 'warn', 'slow query, retrying', ''],
  [22.4, '12:00:08', 'info', 'GET /page/12  200', ''],
  [22.9, '12:00:10', 'error', 'upstream request timeout', 'hit'],
  [23.5, '12:00:11', 'info', 'cache warmed', ''],
  [24.0, '12:00:13', 'error', 'failed to render page 7', ''],
  [24.6, '12:00:14', 'warn', 'retry 1 of 3', ''],
  [31.0, '12:00:21', 'error', 'sync job timeout', 'hit'],
  [31.7, '12:00:22', 'info', 'GET /  200', ''],
  [33.9, '12:00:26', 'error', 'read timeout from notes-db', 'hit late'],
];

function logLine([t, ts, lv, msg, flag]: (typeof LOGS)[number], i: number): string {
  const last = i === LOGS.length - 1;
  return `<div class="lg-l is-${lv}${flag.includes('late') ? ' late' : ''}" data-at="${t}-" data-lv="${lv}"${flag.includes('hit') ? ' data-hit=""' : ''}${last ? ' data-h="copy-line"' : ''}><time>${ts}</time><b>${lv.toUpperCase()}</b><span>${msg}</span>${last ? `<i class="lg-cp">${c.copy}</i>` : ''}</div>`;
}

function drawer(): string {
  const image = WIKI.image;
  return `<aside class="cv-dr"><div class="dr-h"><b>${WIKI.name}</b><span class="nv-flip">${chip('warn', 'starting', 'svc:starting,restart')}${chip('ok', 'up', 'svc:up,up2')}</span><i class="dr-x">&times;</i></div>
<div class="dr-tabs"><span data-h="tab-ov" data-when="dr:open">${c.overview}</span><span data-h="tab-logs" data-when="dr:logs">${c.logs}</span></div>
<div class="dr-pane dr-ov"><dl><div><dt>${c.image}</dt><dd translate="no" dir="ltr">${image}</dd></div><div><dt>${c.ports}</dt><dd>${ports(WIKI)} &rarr; ${WIKI.to}</dd></div><div><dt>${c.uptime}</dt><dd>${sw('svc:starting,up', 'Up 8 seconds')}${sw('svc:restart', '-')}${sw('svc:up2', 'Up 3 seconds')}</dd></div></dl>
<div class="dr-row"><span>${c.autorestart}</span><span class="cv-tg" data-h="toggle"><i></i></span></div>
<div class="dr-row"><span>${c.alert}</span><span class="cv-ck" data-h="check"><i></i></span></div>
<div class="dr-btns">${btn('restart', c.restart, 'pri')}${btn('stop', c.stop)}</div></div>
<div class="dr-pane dr-lg"><div class="lg-tool"><span class="cv-btn lg-lv" data-h="level"><small>${c.level}</small> ${sw('lv:all', c.levels[0] ?? '')}${sw('lv:error', c.levels[3] ?? '')} &#9662;</span><span class="cv-search" data-h="lq"><i class="cv-ic">&#8981;</i>${typed('f-q', 'lq', 'timeout', 29.3, 0.9, c.filterLines)}</span><span class="cv-tg lg-fol" data-h="follow"><i></i><em>${c.follow}</em></span></div>
<div class="lg-menu">${c.levels.map((l, i) => `<span data-h="lv-${['all', 'info', 'warn', 'error'][i]}">${l}</span>`).join('')}</div>
<div class="lg-list">${LOGS.map(logLine).join('')}</div><div class="lg-jump" data-h="jump">&#8595; ${c.jump}</div></div></aside>
<div class="cv-pop"><b>${c.restartQ}</b><p>${c.restartNote}</p><div>${btn('cancel', c.cancel)}${btn('confirm', c.restart, 'pri')}</div></div>
${toast(16.4, 18.0, c.restarted)}${toast(37.0, 38.5, c.copied)}`;
}

function filesView(): string {
  return `<div class="nv-files"><div class="fl-side"><div class="cv-search" data-h="fsearch"><i class="cv-ic">&#8981;</i>${typed('f-fs', 'fs', 'ports', 45.4, 0.8, c.searchNotes)}</div><ul class="nv-tree"><li data-m="">README.md</li><li data-h="folder" data-m="" data-when="exp:0" class="d">&#9656; setup</li><li data-m="" data-when="exp:1" class="d">&#9662; setup</li><li class="nv-ind ch" data-h="note-first" data-when="exp:1" data-sel="first">first-run.md</li><li class="nv-ind ch" data-h="note-ports" data-when="exp:1" data-sel="ports" data-m="">ports.md</li><li>&#9656; journal</li><li>recipes.md</li></ul></div>
<div class="nv-doc"><p class="dc-empty">${c.pick}</p>
<div class="dc sw" data-when="doc:first"><p class="nv-h">First run</p><p>Bothy asks Docker what is running and lists it as <b>services</b>. It does not change those containers.</p><p><code translate="no" dir="ltr">docker compose ps</code></p><p><span class="nv-pill">${v.readOnly}</span></p></div>
<div class="dc sw" data-when="doc:ports"><p class="nv-h">Ports</p><p>The example box publishes <b>8081</b> for Notes web and <b>8090</b> for the wiki. Nothing else is open.</p><p><span class="nv-pill">${v.readOnly}</span></p></div></div></div>`;
}

const LINE_1H = 'M0 50 C20 46 30 54 50 48 S80 30 100 38 S140 52 160 44 S200 24 220 30 S260 42 280 36 L300 40';
const LINE_6H = 'M0 40 C25 30 40 44 60 36 S95 20 120 30 S160 50 190 38 S230 22 260 28 S285 34 300 26';
const LINE_24H = 'M0 54 C30 52 50 40 80 42 S120 26 150 32 S190 48 220 40 S265 20 300 24';

function healthView(): string {
  const tiles = TILES.map((t) => {
    return `<li class="nv-tile" data-h="tile-${t.key}"><small>${t.label}</small><b>${t.num}<span>${t.of}</span></b><em>${t.sub}</em></li>`;
  }).join('');
  const path = (d: string, when: string, a: number, b: number) =>
    `<path class="ln sw" pathLength="1" d="${d}" data-when="${when}" data-draw="${a},${b}" />`;
  return `<ul class="nv-tiles">${tiles}</ul><div class="hl-panel"><div class="hl-h"><b>${c.cpu}</b><span class="cv-seg"><span data-h="range-1h" data-when="rg:1h">1h</span><span data-h="range-6h" data-when="rg:6h">6h</span><span data-h="range-24h" data-when="rg:24h">24h</span></span></div>
<svg viewBox="0 0 300 70" preserveAspectRatio="none" aria-hidden="true"><path class="gl" d="M0 17H300M0 35H300M0 53H300" />${path(LINE_1H, 'rg:1h', 50.3, 51.4)}${path(LINE_6H, 'rg:6h', 52.5, 53.6)}${path(LINE_24H, 'rg:24h', 53.9, 55)}</svg></div>`;
}

function modulesView(): string {
  const rows = MODULES.map((m) => {
    const add = !m.installed;
    const state = add
      ? `<span class="nv-flip">${chip('off', v.notInstalled, 'mod:0')}${chip('ok', v.installed, 'mod:1')}</span>`
      : chip('ok', v.installed);
    return `<tr${add ? ' class="r-new2"' : ''}><td>${m.name}${m.core ? ` <span class="nv-dim">(${v.core})</span>` : ''}</td><td class="nv-n">${m.mib} MiB</td><td>${state}</td></tr>`;
  }).join('');
  return `<table class="nv-t"><thead><tr><th scope="col">${v.th.module}</th><th scope="col" class="nv-n">${v.th.limit}</th><th scope="col">${v.th.state}</th></tr></thead><tbody>${rows}</tbody></table>
<div class="cv-dock" translate="no" dir="ltr" data-h="terminal"><p class="cmd"><span class="nv-pr">$ </span>${typed('cmd-t', 'cmd', 'bothy module add node-metrics', 58.8, 2.0)}</p>
<p class="o"><span class="cv-sp" data-spin="61,63.6"></span><span class="nv-dim" data-at="61-63.6">Working</span></p>
<p class="nv-dim o" data-at="62.4-">Requires edge: installed</p><p class="nv-dim o" data-at="63.2-">Pulling node-exporter, checked against checksums.txt<span class="cv-pgb"><i data-draw="63.2,64.8"></i></span></p><p class="nv-ok o" data-at="65-">Added node-metrics</p></div>`;
}

const BAR = (a: number, h: number[], when: string) =>
  `<g class="bars sw" data-when="${when}">${h.map((y, i) => `<rect x="${8 + i * 14}" y="${62 - y}" width="9" height="${y}" data-draw="${(a + i * 0.04).toFixed(2)},${(a + 0.7 + i * 0.04).toFixed(2)}" />`).join('')}</g>`;

function grafanaPage(): string {
  const line = (d: string, when: string, a: number, b: number) =>
    `<path class="ln sw" pathLength="1" d="${d}" data-when="${when}" data-draw="${a},${b}" />`;
  const area = (d: string, a: number, b: number) => `<path class="ar" d="${d} L300 62 L0 62Z" data-draw="${a},${b}" />`;
  return `<div class="gf"><div class="gf-h"><b>${c.dash}</b><span class="gf-pk" data-h="picker"><small>&#9719;</small> ${sw('gr:6h', c.last6)}${sw('gr:24h', c.last24)} &#9662;</span></div>
<div class="gf-menu"><span>${c.last1}</span><span>${c.last6}</span><span data-h="pk-24h">${c.last24}</span></div>
<div class="gf-grid"><div class="gf-p"><small>${c.cpu}</small><svg viewBox="0 0 300 62" preserveAspectRatio="none" aria-hidden="true"><path class="gl" d="M0 20H300M0 41H300" />${line(LINE_6H, 'gr:6h', 70.2, 71.4)}${line(LINE_24H, 'gr:24h', 76.2, 77.0)}</svg><i class="gf-pt" data-h="cpu-pt"></i><div class="gf-tt"><small>12:40</small><span><i></i>${c.cpu} &middot; ${c.exampleValue}</span></div></div>
<div class="gf-p"><small>${c.memory}</small><svg viewBox="0 0 300 62" preserveAspectRatio="none" aria-hidden="true"><path class="gl" d="M0 20H300M0 41H300" />${area('M0 38 C60 36 100 30 150 31 S240 24 300 22', 70.3, 71.5)}</svg></div>
<div class="gf-p"><small>${c.requests}</small><svg viewBox="0 0 300 62" preserveAspectRatio="none" aria-hidden="true"><path class="gl" d="M0 20H300M0 41H300" />${BAR(70.4, [20, 34, 26, 40, 30, 44, 24, 36, 28, 38, 22, 32, 26, 40, 30, 34, 24, 42, 28, 36], 'gr:6h')}${BAR(76.3, [30, 24, 38, 30, 42, 28, 34, 44, 26, 32, 40, 30, 36, 24, 38, 28, 42, 34, 30, 40], 'gr:24h')}</svg></div>
<div class="gf-p"><small>${c.logRate}</small><svg viewBox="0 0 300 62" preserveAspectRatio="none" aria-hidden="true"><path class="gl" d="M0 20H300M0 41H300" />${BAR(70.5, [14, 18, 16, 24, 20, 12, 18, 26, 22, 16, 20, 14, 24, 18, 22, 16, 20, 26, 18, 14], 'gr:6h')}${BAR(76.4, [18, 22, 14, 20, 26, 16, 24, 18, 12, 22, 20, 26, 16, 22, 18, 14, 24, 20, 22, 16], 'gr:24h')}</svg></div></div></div>`;
}

export const ADDR = { bothy: 'http://box.example:8080/', grafana: 'http://box.example:3000/d/box-health' };

/** The page area. page(false) is the poster, the first frame; page(true) is everything the clip visits. */
export function page(rich: boolean): string {
  const nav = (rich ? ['services', 'files', 'health', 'modules'] : ['services']).map(
    (id) =>
      `<span data-n="${id}"${id === 'services' ? ' class="on"' : ''}${rich ? ` data-h="nav-${id}"` : ''}>${c.nav[id as keyof typeof c.nav]}</span>`,
  );
  const bothy = `<div class="pg on" data-pg="bothy"><div class="cv-nav">${nav.join('')}</div><div class="cv-body"><div class="cv-v on" data-v="services">${servicesView(rich)}</div>${
    rich
      ? `<div class="cv-v" data-v="files">${filesView()}</div><div class="cv-v" data-v="health">${healthView()}</div><div class="cv-v" data-v="modules">${modulesView()}</div>`
      : ''
  }</div></div>`;
  return rich ? `${bothy}<div class="pg" data-pg="grafana">${grafanaPage()}</div>` : bothy;
}
