/**
 * The demo the scroll plays: a short story of using Bothy, written as DATA (BEATS) so a beat is one entry to add.
 * Each beat names the view it shows, the words under the frame, and what happens inside it; the driver
 * (src/story/console.ts) only reads this list. Every beat shows something the product does (docs/guide):
 *
 *   enter     the sign-in page (the realm's login; the fixture types a made-up user)         roles.md
 *   scan      the console asks Docker and the services appear one by one                     the-console.md
 *   services  the table of everything found: state, ports, image                              the-console.md
 *   detail    open one service: its state and the verbs it offers (restart, stop)            the-console.md
 *   health    the health strip's numbers, and a CPU line (Prometheus vitals)                  the-console.md
 *   files     Bothy Files: a note rendered as a document                                      files.md
 *   modules   `bothy module add node-metrics`, then the module list with its memory          cli: module add
 *
 * The frame is fixtures only; nothing here is live and the badge on the frame says so.
 */
import { esc } from './components.ts';
import type { ModulesFixture, ServicesFixture } from './types.ts';

export type Scene = 'login' | 'services' | 'health' | 'files' | 'modules';

export interface Beat {
  id: string;
  /** Short name in the step indicator. */
  label: string;
  /** The line under the frame while this beat plays. Says only what docs/guide documents. */
  caption: string;
  /** Which view of the frame is on screen. */
  scene: Scene;
  /** Share of the scroll this beat gets (relative; 1 is the usual). */
  weight: number;
  /** How long the beat plays on its own clock, in ms. The scroll starts it; it is never paced by the scroll. */
  ms: number;
  /** Positions (0..1, the last 1) where the beat is at rest. A stretch is unlocked by scrolling and plays to the next rest. */
  rests: readonly number[];
}

export const BEATS: readonly Beat[] = [
  {
    id: 'enter',
    label: 'Sign in',
    scene: 'login',
    weight: 2.6,
    ms: 8500,
    rests: [0.21, 0.4, 0.58, 0.78, 1],
    caption: 'Sign in with the login your realm gives you.',
  },
  {
    id: 'scan',
    label: 'Discover',
    scene: 'services',
    weight: 1.9,
    ms: 4200,
    rests: [0.64, 1],
    caption: 'Nothing to configure. It asks Docker what is running.',
  },
  {
    id: 'services',
    label: 'Services',
    scene: 'services',
    weight: 1.8,
    ms: 5000,
    rests: [0.2, 0.36, 0.52, 0.68, 1],
    caption: 'Every service on one page: state, ports, image.',
  },
  {
    id: 'detail',
    label: 'Open one',
    scene: 'services',
    weight: 1.6,
    ms: 4000,
    rests: [0.58, 1],
    caption: 'Open one to see its state, and restart or stop it.',
  },
  {
    id: 'health',
    label: 'Health',
    scene: 'health',
    weight: 1.7,
    ms: 4200,
    rests: [0.5, 1],
    caption: 'One glance at whether the machine is all right.',
  },
  {
    id: 'files',
    label: 'Files',
    scene: 'files',
    weight: 1.5,
    ms: 3500,
    rests: [1],
    caption: 'Notes kept on the machine, read as documents.',
  },
  {
    id: 'modules',
    label: 'Modules',
    scene: 'modules',
    weight: 2.2,
    ms: 4800,
    rests: [0.58, 1],
    caption: 'Add a module from the command line, and see its memory.',
  },
];

/** The sign-in scene: a made-up user, a masked password, a button. Typed by the driver. */
export const LOGIN = { user: 'sam', passwordDots: 9 } as const;

/** The scene HTML that sits inside `.console-frame` beside the four views. Site-drawn, so it carries its own `cf-` classes. */
export function renderLogin(): string {
  const dots = '•'.repeat(LOGIN.passwordDots);
  return [
    '<div class="cf-panel cf-panel-login" role="group" aria-label="Sign in">',
    '<div class="cf-login">',
    '<p class="cf-login-mark" translate="no">Bothy</p>',
    '<p class="cf-login-h">Sign in</p>',
    '<div class="cf-field"><span class="cf-field-l">Username</span>',
    `<span class="cf-field-v" data-type="${esc(LOGIN.user)}" dir="ltr"><span class="cf-typed"></span><i class="cf-caret"></i></span></div>`,
    '<div class="cf-field"><span class="cf-field-l">Password</span>',
    `<span class="cf-field-v" data-type="${dots}" dir="ltr"><span class="cf-typed"></span><i class="cf-caret"></i></span></div>`,
    '<p class="cf-login-btn" data-signin><span class="cf-btn-t">Sign in</span><span class="cf-btn-l" aria-hidden="true"><i class="cf-spin"></i>Signing in</span><i class="cf-btn-bar"></i></p>',
    '</div></div>',
  ].join('');
}

/** The strip above the Services table while the console is asking Docker. */
export function renderScanBar(f: ServicesFixture): string {
  return [
    '<div class="cf-scanbar" aria-hidden="true">',
    '<span class="cf-sweep"></span>',
    `<span class="cf-scan-t"><span class="cf-scan-ask">Asking Docker</span><span class="cf-scan-done">Found</span> <b class="cf-scan-n" data-of="${f.nodes.length}">${f.nodes.length}</b> <span class="cf-scan-u">services</span></span>`,
    '</div>',
  ].join('');
}

/** The slide-in panel for one service: only what the table row and the three verbs already say. */
export function renderDetail(f: ServicesFixture): string {
  const n = f.nodes[0];
  if (!n) return '';
  const image = n.container?.image ?? '';
  const ports = n.ports.map((p) => `${p.hostPort}:${p.containerPort}/${p.proto}`).join(', ');
  return [
    '<aside class="cf-detail" aria-hidden="true">',
    `<p class="cf-detail-h"><bdi>${esc(n.name)}</bdi></p>`,
    '<dl>',
    '<div><dt>State</dt><dd>Up</dd></div>',
    `<div><dt>Image</dt><dd dir="ltr" translate="no">${esc(image)}</dd></div>`,
    `<div><dt>Ports</dt><dd dir="ltr" translate="no">${esc(ports)}</dd></div>`,
    '</dl>',
    '<p class="cf-detail-verbs"><span>Restart</span><span>Stop</span></p>',
    '</aside>',
  ].join('');
}

/** A CPU line for the health view (the Overview's vitals are drawn from Prometheus; these numbers are made up). */
export function renderSpark(): string {
  const pts = [14, 18, 15, 22, 19, 26, 24, 31, 27, 23, 28, 21, 19, 24, 18];
  const w = 300;
  const h = 56;
  const xy = pts.map((v, i) => `${Math.round((i * w) / (pts.length - 1))},${Math.round(h - (v / 40) * h)}`);
  return [
    '<div class="cf-spark" aria-hidden="true">',
    '<p class="cf-spark-l">CPU, last hour</p>',
    `<svg viewBox="0 0 ${w} ${h}" focusable="false"><polyline pathLength="1" points="${xy.join(' ')}" fill="none" stroke="currentColor" stroke-width="2.5" stroke-linejoin="round" stroke-linecap="round"/></svg>`,
    '</div>',
  ].join('');
}

/**
 * The module list as the flow shows it: the command that is typed, then one row per module with its memory as a bar.
 * `node-metrics` is the row that arrives; it is available in the fixture and installed once the command has run.
 */
export function renderModuleFlow(f: ModulesFixture): string {
  const adds = 'node-metrics';
  const total = f.modules.reduce((a, m) => a + m.memory_mib, 0) || 1;
  const rows = f.modules
    .map((m) => {
      const arriving = m.name === adds;
      return `<li class="cf-mod${arriving ? ' cf-mod-new' : ''}"><span class="cf-mod-n" translate="no">${esc(m.name)}</span><span class="cf-mod-s">${arriving || m.installed ? 'installed' : 'available'}</span><span class="cf-mod-m">${m.memory_mib} Mi</span><span class="cf-mod-bar"><i style="inline-size:${Math.round((m.memory_mib / total) * 100)}%"></i></span></li>`;
    })
    .join('');
  return [
    '<div class="cf-modflow" aria-hidden="true">',
    `<pre class="cf-cmd" dir="ltr" translate="no"><code><span class="cf-cmd-p">$ </span><span class="cf-typed" data-type="bothy module add ${adds}"></span><i class="cf-caret"></i></code></pre>`,
    `<ul class="cf-mods">${rows}</ul>`,
    '</div>',
  ].join('');
}

/** The captions as a numbered list: the static page's readable account of the demo, the live page's caption stack. */
export function renderSteps(beats: readonly Beat[] = BEATS): string {
  const li = beats
    .map(
      (b, i) =>
        `<li class="cf-step" data-beat="${i}"><b class="cf-step-l">${esc(b.label)}</b> <span class="cf-step-t">${esc(b.caption)}</span></li>`,
    )
    .join('');
  // `cf-sr` is the live region: the step, said once per change, for a reader who cannot see the frame move
  return `<div class="cf-flow"><ol class="cf-steps">${li}</ol><p class="cf-sr" role="status" aria-live="polite"></p></div>`;
}
