// Guards for the console views on the site (src/console, scripts/render-console.mjs).
//
//  1. TRUTH: every fixture carries only fields the product has, with values the product allows, and the visible column
//     names, tile labels, module catalogue and `bothy module list` layout are the product's own. If the product changes
//     and a fixture does not, this fails and the site cannot show a screen that no longer exists.
//  2. ISOLATION: the console stylesheet reaches nothing outside `.console-frame`, and none of the site's tokens or
//     element rules reach in.
//  3. DISPLAY RULES (data-display, web-interface-guidelines): direction by value type, one empty placeholder, no datum
//     twice in a row, tabular figures, reduced motion, tabs a keyboard can reach.
//  4. HYGIENE: example data only (the build's leak scan patterns stay clean), generated files are current, size budget.
import assert from 'node:assert/strict';
import { readdirSync, readFileSync, statSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join, resolve } from 'node:path';
import { test } from 'node:test';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { gzipSync } from 'node:zlib';
import {
  CLASS_ALIAS,
  SERVICE_COLUMNS,
  MODULE_HEADER,
  STATUS,
  TONE,
  moduleListText,
  renderMd,
  titleOf,
} from './components.ts';
import { EN } from './frame.ts';
import type { FilesFixture, HealthFixture, ModulesFixture, ServicesFixture } from './types.ts';

const here = dirname(fileURLToPath(import.meta.url));
const site = resolve(here, '..', '..');
const repo = resolve(site, '..');
const web = join(repo, 'apps/bothy-web/web/src');
const read = (p: string) => readFileSync(p, 'utf8');
const fixture = <T>(name: string): T => JSON.parse(read(join(site, 'fixtures/console', name))) as T;

const services = fixture<ServicesFixture>('services.json');
const health = fixture<HealthFixture>('health.json');
const files = fixture<FilesFixture>('files.json');
const modules = fixture<ModulesFixture>('modules.json');

const script = (await import(pathToFileURL(join(site, 'scripts/render-console.mjs')).href)) as {
  build: () => Promise<{ css: string; fragments: string; frame: string; panels: Record<string, string> }>;
  OUT_CSS: string;
  OUT_FRAGMENTS: string;
};
const built = await script.build();
const postcss = createRequire(import.meta.url)('postcss') as typeof import('postcss');

// ── reading the product's source ──────────────────────────────────────────

/** The top-level field names of `interface Name { ... }` in a TypeScript source. */
function fieldsOf(src: string, name: string): Set<string> {
  const at = src.search(new RegExp(`(?:export )?interface ${name}\\b[^{]*\\{`));
  assert.ok(at >= 0, `the product no longer declares interface ${name}`);
  let i = src.indexOf('{', at);
  const start = i;
  let depth = 0;
  for (; i < src.length; i++) {
    if (src[i] === '{') depth++;
    if (src[i] === '}' && --depth === 0) break;
  }
  const body = src.slice(start + 1, i);
  const out = new Set<string>();
  let d = 0;
  for (const line of body.split('\n')) {
    if (d === 0) {
      const m = /^ {2}(?:readonly )?(\w+)\??\s*:/.exec(line);
      if (m?.[1]) out.add(m[1]);
    }
    for (const ch of line.replace(/\/\/.*$/, '')) {
      if (ch === '{') d++;
      if (ch === '}') d--;
    }
  }
  return out;
}

/** The members of `type Name = 'a' | 'b' | ...;`. */
function unionOf(src: string, name: string): string[] {
  const m = new RegExp(`type ${name}\\s*=\\s*([^;]+);`).exec(src);
  assert.ok(m?.[1], `the product no longer declares type ${name}`);
  return [...m[1].matchAll(/'([^']+)'/g)].map((x) => x[1] ?? '');
}

const discover = read(join(web, 'lib/discover.ts'));
const filesLib = read(join(web, 'lib/files.ts'));
const controlHome = read(join(web, 'pages/control/ControlHome.tsx'));
const healthStrip = read(join(web, 'components/control-home/HealthStrip.tsx'));
const parts = read(join(web, 'components/control-home/parts.tsx'));
const serviceTable = read(join(web, 'components/ServiceTable.tsx'));
const iconsTsx = read(join(web, 'lib/icons.tsx'));
const goModule = read(join(repo, 'cli/internal/install/module.go'));
const modesYml = read(join(repo, 'stack/modes.yml'));

/** Every key of every object of `rows` is in `allowed`. */
function onlyFieldsOf(rows: object[], allowed: Set<string>, what: string, extra: string[] = []): void {
  for (const row of rows) {
    for (const k of Object.keys(row)) {
      if (k === '_comment' || extra.includes(k)) continue;
      assert.ok(allowed.has(k), `${what}: the fixture has "${k}", which the product's type does not`);
    }
  }
}

// ── 1. truth ──────────────────────────────────────────────────────────────

test('services fixture has only PortalNode, NodeContainer, Port and NodeRoute fields, with the product values', () => {
  const nodeFields = fieldsOf(discover, 'PortalNode');
  onlyFieldsOf(services.nodes, nodeFields, 'PortalNode');
  onlyFieldsOf(
    services.nodes.flatMap((n) => (n.container ? [n.container] : [])),
    fieldsOf(discover, 'NodeContainer'),
    'NodeContainer',
  );
  onlyFieldsOf(
    services.nodes.flatMap((n) => n.ports),
    fieldsOf(discover, 'Port'),
    'Port',
  );
  onlyFieldsOf(
    services.nodes.flatMap((n) => (n.route ? [n.route] : [])),
    fieldsOf(discover, 'NodeRoute'),
    'NodeRoute',
  );
  onlyFieldsOf(
    services.nodes.flatMap((n) => (n.container?.health ? [n.container.health] : [])),
    fieldsOf(discover, 'DockerHealth'),
    'DockerHealth',
  );
  const status = unionOf(discover, 'Status');
  const kind = unionOf(discover, 'Kind');
  for (const n of services.nodes) {
    assert.ok(status.includes(n.status), `status ${n.status} is not a product Status`);
    assert.ok(kind.includes(n.kind), `kind ${n.kind} is not a product Kind`);
  }
  assert.deepEqual(
    Object.keys(STATUS).sort(),
    [...status].sort(),
    'the status table covers exactly the product statuses',
  );
});

test('the site types are subsets of the product types', () => {
  const types = read(join(here, 'types.ts'));
  const pairs: [string, string, string][] = [
    ['ServiceNode', 'PortalNode', discover],
    ['NodeContainer', 'NodeContainer', discover],
    ['Port', 'Port', discover],
    ['NodeRoute', 'NodeRoute', discover],
    ['HealthTile', 'Tile', healthStrip],
    ['FileRoot', 'FileRoot', filesLib],
    ['TreeFile', 'TreeFile', filesLib],
    ['Commit', 'Commit', filesLib],
    ['FileRead', 'FileRead', filesLib],
  ];
  for (const [mine, theirs, src] of pairs) {
    const product = fieldsOf(src, theirs);
    for (const f of fieldsOf(types, mine))
      assert.ok(product.has(f), `${mine}.${f} is not a field of the product's ${theirs}`);
  }
});

test('the Services table headings are the product ServiceTable headings, in order', () => {
  const heads = [...serviceTable.matchAll(/<th\b([^>]*?)(?:\/>|>([^<]*)<\/th>)/g)].map(
    (m) => (m[2] ?? '').trim() || /aria-label="([^"]+)"/.exec(m[1] ?? '')?.[1] || '',
  );
  assert.deepEqual(
    SERVICE_COLUMNS.map((c) => c.text || c.aria),
    heads,
  );
  const rendered = [...built.panels.services!.matchAll(/<th\b([^>]*)>([^<]*)<\/th>/g)].map(
    (m) => m[2] || /aria-label="([^"]+)"/.exec(m[1] ?? '')?.[1] || '',
  );
  assert.deepEqual(rendered, heads);
});

test('the status words, glyph tokens and tone words are the product ones', () => {
  for (const [status, s] of Object.entries(STATUS)) {
    assert.ok(
      iconsTsx.includes(`${status}: '${s.label}'`) || new RegExp(`${status}: '${s.label}'`).test(iconsTsx),
      `label for ${status}`,
    );
    assert.ok(iconsTsx.includes(`'${s.token}'`), `token ${s.token} is not one lib/icons.tsx uses`);
  }
  for (const [tone, t] of Object.entries(TONE)) {
    assert.ok(new RegExp(`${tone}: \\{[^}]*word: '${t.word}'`).test(parts), `tone word for ${tone}`);
  }
});

test('health tiles are Tile objects with a label, key and link the Control landing defines', () => {
  onlyFieldsOf(health.tiles, fieldsOf(healthStrip, 'Tile'), 'Tile');
  const tones = unionOf(parts, 'Tone');
  for (const t of health.tiles) {
    assert.ok(tones.includes(t.tone), `tone ${t.tone}`);
    assert.ok(controlHome.includes(`key: '${t.key}'`), `ControlHome has no tile keyed ${t.key}`);
    assert.ok(controlHome.includes(`label: '${t.label}'`), `ControlHome has no tile labelled ${t.label}`);
    assert.ok(controlHome.includes(`to: '${t.to}'`), `ControlHome links no tile to ${t.to}`);
    assert.ok(controlHome.includes(`'${t.toneLabel}'`), `ControlHome never says "${t.toneLabel}"`);
  }
});

test('files fixture has only FileRoot, TreeFile, FileRead and Commit fields', () => {
  onlyFieldsOf([files], new Set(), 'files fixture', ['asOf', 'roots', 'open', 'tree', 'file']);
  onlyFieldsOf(files.roots, fieldsOf(filesLib, 'FileRoot'), 'FileRoot');
  onlyFieldsOf(files.tree, fieldsOf(filesLib, 'TreeFile'), 'TreeFile');
  onlyFieldsOf([files.file], fieldsOf(filesLib, 'FileRead'), 'FileRead');
  onlyFieldsOf(files.file.history, fieldsOf(filesLib, 'Commit'), 'Commit');
  for (const e of files.tree) {
    // The product's measured shapes: `dir` is the boolean true for a directory, the parent path (a string) for a file.
    if (e.dir === true) assert.equal(e.size, undefined, 'a directory carries no size');
    else assert.equal(e.dir, e.path.includes('/') ? e.path.slice(0, e.path.lastIndexOf('/')) : '');
  }
  assert.ok(
    files.roots.some((r) => r.key === files.file.root),
    'the open file is in a listed root',
  );
  assert.ok(
    files.tree.some((e) => e.path === files.file.path),
    'the open file is in the tree',
  );
});

test('modules fixture is the `bothy module list --json` row of the Go source and the catalogue of stack/modes.yml', () => {
  const struct = /type ModuleRow struct \{([\s\S]*?)\n\}/.exec(goModule)?.[1] ?? '';
  const tags = [...struct.matchAll(/json:"(\w+)(,omitempty)?"/g)].map((m) => ({ name: m[1] ?? '', optional: !!m[2] }));
  assert.ok(tags.length >= 9, 'could not read ModuleRow');
  for (const m of modules.modules) {
    for (const k of Object.keys(m))
      assert.ok(
        tags.some((t) => t.name === k),
        `module row field "${k}" is not in ModuleRow`,
      );
    for (const t of tags.filter((x) => !x.optional)) assert.ok(t.name in m, `module row lacks "${t.name}"`);
  }
  // The catalogue: name, description, memory, requires and services as stack/modes.yml declares them.
  const block = (name: string): string => {
    const at = modesYml.search(new RegExp(`^  ${name}:\\s*$`, 'm'));
    assert.ok(at >= 0, `stack/modes.yml no longer declares module ${name}`);
    const rest = modesYml.slice(at + 1);
    const next = rest.search(/\n {2}\S[^\n]*:\s*(#.*)?\n/);
    return next < 0 ? rest : rest.slice(0, next);
  };
  const list = (b: string, key: string) =>
    (new RegExp(`^    ${key}: \\[([^\\]]*)\\]`, 'm').exec(b)?.[1] ?? '')
      .split(',')
      .map((s) => s.trim())
      .filter(Boolean);
  for (const m of modules.modules) {
    const b = block(m.name);
    assert.equal(new RegExp(`^    memory_mib: ${m.memory_mib}\\b`, 'm').test(b), true, `${m.name}: memory_mib`);
    assert.ok(b.includes(`description: ${m.description}`), `${m.name}: description`);
    assert.deepEqual(list(b, 'requires'), m.requires, `${m.name}: requires`);
    assert.deepEqual(list(b, 'services'), m.services, `${m.name}: services`);
    assert.equal(/^ {4}core: true/m.test(b), !!m.core, `${m.name}: core`);
  }
});

test('the module listing is laid out the way module.go prints it', () => {
  for (const word of MODULE_HEADER)
    assert.ok(goModule.includes(`"${word}"`), `module.go no longer prints the heading ${word}`);
  assert.ok(goModule.includes('"%-14s %-10s %8s  %s\\n"'), 'the heading format changed');
  assert.ok(goModule.includes('"%-14s %-10s %5d Mi  %s; %s\\n"'), 'the row format changed');
  for (const state of ['available', 'core', 'installed']) assert.ok(goModule.includes(`"${state}"`), `state ${state}`);
  assert.ok(goModule.includes("Memory is the sum of the module's container limits (what the budget gate counts)."));
  const text = moduleListText(modules);
  const rows = text.split('\n').filter((l) => /^\S+ +(core|installed|available) /.test(l));
  assert.equal(rows.length, modules.modules.length);
  // Columns line up: every row's state and memory sit at the heading's offsets.
  const heading = text.split('\n').find((l) => l.startsWith('MODULE')) ?? '';
  for (const r of rows) {
    assert.equal(
      r.indexOf('Mi  ') + 2,
      heading.indexOf('MEMORY') + 'MEMORY'.length,
      'memory column is right-aligned under its heading',
    );
  }
});

test('every class the views use exists in the product source, or is one of ours', () => {
  const all: string[] = [];
  const walk = (d: string) => {
    for (const f of readdirSync(d)) {
      const p = join(d, f);
      if (statSync(p).isDirectory()) walk(p);
      else if (/\.(css|tsx)$/.test(f)) all.push(read(p));
    }
  };
  walk(web);
  const product = all.join('\n');
  const html = Object.values(built.panels).join('');
  const used = new Set(
    [...html.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => (m[1] ?? '').split(/\s+/).filter(Boolean)),
  );
  const missing = [...used].filter(
    (c) => !/^(cx-|cf-)/.test(c) && !new RegExp(`(?<![\\w-])${c}(?![\\w-])`).test(product),
  );
  // `si-<status>`, `md-h<level>` and `ico sm` are built in the product from template strings.
  const dynamic = missing.filter((c) => !/^(si-\w+|md-h[1-6])$/.test(c));
  assert.deepEqual(dynamic, [], 'classes the product source never mentions');
  for (const s of Object.keys(STATUS)) assert.ok(iconsTsx.includes('si si-${status}'), `status class pattern for ${s}`);
});

test('the Files view is built from classes the Reader and md renderer use, and the markdown stays in their subset', () => {
  assert.equal(titleOf('setup/first-run.md'), 'First run');
  assert.equal(titleOf('README.md'), 'README');
  const md = renderMd(files.file.content);
  assert.match(md, /<h2 class="md-h md-h1"/, 'a document # is an h2, as md.tsx shifts it');
  assert.ok(
    read(join(web, 'pages/files/md.tsx')).includes('Math.min(lvl + 1, 6)'),
    'md.tsx still shifts headings down one level',
  );
});

// ── 2. isolation ──────────────────────────────────────────────────────────

const rules = (css: string) => {
  const out: { selectors: string[]; decls: string[]; atRule: string }[] = [];
  postcss.parse(css).walkRules((r) => {
    if (r.parent?.type === 'atrule' && /keyframes$/.test((r.parent as { name: string }).name)) return;
    const at = r.parent?.type === 'atrule' ? (r.parent as { name: string }).name : '';
    const decls: string[] = [];
    r.walkDecls((d) => {
      decls.push(d.prop);
    });
    out.push({ selectors: r.selectors, decls, atRule: at });
  });
  return out;
};

test('every console rule is scoped under .console-frame; the frame chrome stays under .cf', () => {
  const frameChrome = /^\.(cf-[\w-]+|cf|console-frame)(?![\w-])/;
  const stray: string[] = [];
  for (const r of rules(built.css)) for (const s of r.selectors) if (!frameChrome.test(s)) stray.push(s);
  assert.deepEqual(stray, [], 'selectors that can reach the rest of the page');
  assert.ok(
    !/(^|[\s,{])(:root|html|body)\b/.test(built.css.replace(/\/\*[\s\S]*?\*\//g, '')),
    ':root, html or body rule leaked through',
  );
});

test('console tokens are declared only on .console-frame and the frame chrome tokens only on .cf', () => {
  const css = built.css;
  const bad: string[] = [];
  for (const r of rules(css)) {
    const customs = r.decls.filter((d) => d.startsWith('--'));
    if (!customs.length) continue;
    for (const s of r.selectors) {
      if (customs.some((c) => c.startsWith('--cf-')) && !/^\.cf(?![\w-])/.test(s)) bad.push(`${s} {${customs}}`);
      if (customs.some((c) => !c.startsWith('--cf-')) && !/^\.console-frame(?![\w-])/.test(s))
        bad.push(`${s} {${customs}}`);
    }
  }
  assert.deepEqual(bad, []);
});

test('the console part reads only tokens the console part defines, and never a frame token', () => {
  const root = postcss.parse(built.css);
  const defined = new Set<string>();
  root.walkDecls((d) => {
    if (d.prop.startsWith('--') && !d.prop.startsWith('--cf-')) defined.add(d.prop);
  });
  const missing = new Set<string>();
  root.walkRules((r) => {
    const consoleRule = r.selectors.every((s) => s.startsWith('.console-frame'));
    r.walkDecls((d) => {
      for (const m of d.value.matchAll(/var\((--[\w-]+)(,[^)]*)?\)/g)) {
        const name = m[1] ?? '';
        if (consoleRule && name.startsWith('--cf-')) missing.add(`${name} (a site token inside the console)`);
        if (consoleRule && !name.startsWith('--cf-') && !defined.has(name) && !m[2]) missing.add(name);
      }
    });
  });
  // Tokens the console sets at runtime (per element) rather than in a stylesheet.
  const runtime = new Set(['--depth', '--read-w', '--acc', '--rd-index-h', '--rail-l', '--rail-r', '--panel-h']);
  assert.deepEqual(
    [...missing].filter((m) => !runtime.has(m.split(' ')[0] ?? '')),
    [],
  );
});

test('the console stylesheet carries no physical left or right (the site is built to need no second stylesheet for Hebrew)', () => {
  assert.doesNotMatch(
    built.css.replace(/\/\*[\s\S]*?\*\//g, ''),
    /(margin|padding|border)-(left|right)|text-align: *(left|right)|(^|[^-])(left|right): /,
  );
  assert.doesNotMatch(built.css, /url\(["']?https?:\/\/|@import/);
});

test('the renamed classes are product classes, and the product rules reach them under the new name', () => {
  const productSrc = [read(join(web, 'index.css')), read(join(web, 'pages/Services.tsx'))].join('\n');
  for (const [from, to] of Object.entries(CLASS_ALIAS)) {
    assert.ok(new RegExp(`(?:\\.|["' ])${from}(?![\\w-])`).test(productSrc), `the product has no .${from}`);
    assert.ok(new RegExp(`\\.console-frame \\.${to}(?![\\w-])`).test(built.css), `no rule for .${to}`);
    assert.ok(!new RegExp(`\\.${from}(?![\\w-])`).test(built.css), `.${from} survived in the console CSS`);
  }
});

test('no class of the views is also a class of the site stylesheet', () => {
  const siteCss = read(join(site, 'src/styles/site.css'));
  const siteClasses = new Set([...siteCss.matchAll(/\.(-?[_a-zA-Z][\w-]*)/g)].map((m) => m[1] ?? ''));
  const html = built.frame;
  const used = new Set(
    [...html.matchAll(/\sclass="([^"]*)"/g)].flatMap((m) => (m[1] ?? '').split(/\s+/).filter(Boolean)),
  );
  const clash = [...used].filter((c) => !c.startsWith('cf') && siteClasses.has(c));
  assert.deepEqual(clash, [], 'a class both sheets style: one of them would restyle the other');
});

// ── 3. display rules ──────────────────────────────────────────────────────

const text = (html: string) =>
  html
    .replace(/<[^>]+>/g, ' ')
    .replace(/&[a-z]+;/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();

test('machine strings carry dir="ltr"; names and commit text a person typed are isolated with <bdi>', () => {
  const html = built.frame;
  for (const m of html.matchAll(
    /<(\w+)\b([^>]*\bclass="[^"]*\b(?:mono|pt|rd-sha|rd-crumb|rd-dir-name|rd-root-name|md-pre)\b[^"]*"[^>]*)>/g,
  )) {
    assert.match(m[2] ?? '', /\bdir="ltr"/, `<${m[1]}> is a machine string and has no dir="ltr": ${m[2]}`);
  }
  assert.doesNotMatch(html, /dir="auto"|<bdo\b/, 'never dir=auto on an id, a path or a command, never <bdo>');
  for (const n of services.nodes) assert.ok(html.includes(`<bdi>${n.name}</bdi>`), `${n.name} is not isolated`);
  assert.ok(html.includes(`<bdi>${files.file.history[0]?.author}</bdi>`));
  assert.match(html, /<div class="console-frame" dir="ltr"/, 'the frame itself is left to right');
});

test('one empty placeholder: an em dash with an accessible name, never a bare hyphen or a word', () => {
  const html = Object.values(built.panels).join('');
  assert.ok((html.match(/class="cx-empty"/g) ?? []).length >= 1);
  assert.doesNotMatch(html, /<td[^>]*>\s*-\s*<\/td>/, 'a bare hyphen cell');
  assert.doesNotMatch(html, />\s*(n\/a|none|null|undefined|NaN|unknown date)\s*</i);
  for (const m of html.matchAll(/<span class="cx-empty"[^>]*>([^<]*)<\/span>/g)) assert.equal(m[1], '—');
  assert.match(html, /class="cx-empty" role="img" aria-label="No value"/);
});

test('no datum twice in one Services row', () => {
  for (const row of built.panels.services!.matchAll(/<tr class="svc-tr">([\s\S]*?)<\/tr>/g)) {
    const cells = [...(row[1] ?? '').matchAll(/<(?:td|span class="(?:nm-text|pt)")[^>]*>([\s\S]*?)<\/(?:td|span)>/g)];
    const seen = new Map<string, string>();
    for (const c of cells) {
      const t = text(c[1] ?? '')
        .replace(/^:/, '')
        .toLowerCase();
      if (!t || t === '—' || t.length < 3) continue;
      assert.ok(!seen.has(t), `"${t}" is shown twice in one row`);
      seen.set(t, t);
    }
    const name = /class="nm-text"><bdi>([^<]*)/.exec(row[1] ?? '')?.[1] ?? '';
    const sub = /class="pt"[^>]*>([^<]*)/.exec(row[1] ?? '')?.[1] ?? '';
    assert.notEqual(name.toLowerCase(), sub.toLowerCase(), 'the line under a name repeats the name');
    const ports = /data-label="Ports"[^>]*>([^<]*)/.exec(row[1] ?? '')?.[1] ?? '';
    assert.ok(
      !ports.split(', ').some((p) => /^\d+$/.test(p) && sub === `:${p}`),
      'the sub-line repeats the Ports column',
    );
  }
});

test('figures: tabular numerals wherever a count, a size or a time sits in a column', () => {
  const css = built.css;
  for (const cls of ['ch-num', 'ch-tile-value', 'ch-asof', 'rd-dir-n', 'rd-root-n', 'rd-sha', 'pt', 'mono']) {
    let ok = false;
    postcss.parse(css).walkRules((r) => {
      if (r.selectors.some((s) => new RegExp(`\\.${cls}(?![\\w-])[^ ]*$`).test(s))) {
        r.walkDecls('font-variant-numeric', (d) => {
          ok ||= /tabular-nums/.test(d.value);
        });
      }
    });
    assert.ok(ok, `.${cls} is not set in tabular figures`);
  }
});

test('motion: nothing moves under prefers-reduced-motion, and no frame transition survives', () => {
  assert.match(
    built.css,
    /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.console-frame \*[\s\S]*animation: none !important/,
  );
  assert.match(built.css, /@media \(prefers-reduced-motion: reduce\)[\s\S]*\.cf-tab[\s\S]*transition: none/);
  assert.doesNotMatch(built.frame, /<video|<audio|autoplay/);
});

test('tabs are real radios a keyboard reaches: one group, labelled, one checked, none hidden from focus', () => {
  const html = built.frame;
  const radios = [
    ...html.matchAll(/<input class="cf-r" type="radio" name="([^"]+)" id="([^"]+)" value="(\w+)"( checked)?/g),
  ];
  assert.equal(radios.length, EN.tabs.length);
  assert.equal(new Set(radios.map((r) => r[1])).size, 1, 'one radio group');
  assert.equal(radios.filter((r) => r[4]).length, 1, 'exactly one tab starts checked');
  for (const r of radios) assert.ok(html.includes(`<label class="cf-tab" for="${r[2]}">`), `no label for ${r[2]}`);
  assert.doesNotMatch(html, /tabindex="-1"/);
  assert.match(html, /role="radiogroup" aria-label="Console view"/);
  const css = built.css;
  let hidden = false;
  postcss.parse(css).walkRules((r) => {
    if (r.selectors.includes('.cf-r'))
      r.walkDecls((d) => {
        hidden ||= /^(display|visibility)$/.test(d.prop) && /none|hidden/.test(d.value);
      });
  });
  assert.equal(hidden, false, 'a display:none or visibility:hidden radio cannot be focused');
  assert.match(
    css,
    /\.cf-r:focus-visible\s*\+\s*\.cf-tab\s*\{[^}]*outline:\s*3px/,
    'the focused tab has a visible ring',
  );
  assert.match(css, /\.cf-tab\s*\{[^}]*min-block-size:\s*2\.75rem/, 'a 44px target');
  for (const t of EN.tabs)
    assert.match(css, new RegExp(`\\.cf-panel\\.cf-panel-${t.id}`), `no rule shows the ${t.id} panel`);
  assert.match(css, /@supports selector\(:has\(\*\)\)/, 'without :has every panel shows rather than none');
});

test('the views are inert pictures: no links, buttons, forms or ids that clash; scroll regions are named; headings fit the page outline', () => {
  const html = built.frame;
  const insideFrame = /<div class="console-frame"[\s\S]*<\/div>\s*<\/div>\s*<figcaption/.exec(html)?.[0] ?? '';
  assert.ok(insideFrame.length > 1000);
  assert.doesNotMatch(insideFrame, /<(a|button|form|input|select|textarea)\b/, 'a dead control inside the frame');
  assert.doesNotMatch(insideFrame, /\shref=/);
  assert.doesNotMatch(html, /<main\b/, 'a second main landmark');
  for (const m of html.matchAll(/<h1\b([^>]*)>/g))
    assert.match(m[1] ?? '', /aria-level="3"/, 'an h1 inside the frame would be a second page title');
  for (const m of html.matchAll(/<(\w+)\b([^>]*\btabindex="0"[^>]*)>/g)) {
    assert.match(m[2] ?? '', /aria-label="[^"]+"|role="region"/, `<${m[1]} tabindex=0> has no name`);
  }
  const ids = [...html.matchAll(/\sid="([^"]+)"/g)].map((m) => m[1]);
  assert.equal(new Set(ids).size, ids.length, 'duplicate ids');
  assert.doesNotMatch(html, /<script|\son\w+=|javascript:/i);
});

test('the three.js components are not used by any view', () => {
  const css = script.build.toString();
  assert.doesNotMatch(css, /components\/three/);
  assert.ok(!built.css.includes('three'), 'no three.js selector in the stylesheet');
});

// ── 4. hygiene ────────────────────────────────────────────────────────────

test('example data only: the build leak scan is clean over the fixtures, the fragments and the stylesheet', () => {
  const { patterns } = JSON.parse(read(join(site, 'leak-patterns.json'))) as {
    patterns: { name: string; source: string; flags: string }[];
  };
  const raws = [
    ['services fixture', read(join(site, 'fixtures/console/services.json'))],
    ['health fixture', read(join(site, 'fixtures/console/health.json'))],
    ['files fixture', read(join(site, 'fixtures/console/files.json'))],
    ['modules fixture', read(join(site, 'fixtures/console/modules.json'))],
    ['fragments', built.fragments],
    ['stylesheet', built.css],
  ] as const;
  for (const [what, body] of raws) {
    for (const p of patterns)
      assert.doesNotMatch(body, new RegExp(p.source, p.flags), `${what} matches the leak pattern "${p.name}"`);
  }
  // Beyond the shapes: any host in a fixture is a reserved example name, any address is a wildcard or loopback.
  const fixtures = raws
    .slice(0, 4)
    .map(([, b]) => b)
    .join('\n');
  for (const m of fixtures.matchAll(/https?:\/\/([^/:"\s]+)/g))
    assert.match(m[1] ?? '', /\.example$/, `${m[1]} is not a reserved example host`);
  for (const m of fixtures.matchAll(/\b(\d{1,3}(?:\.\d{1,3}){3})\b/g))
    assert.ok(['0.0.0.0', '127.0.0.1'].includes(m[1] ?? ''), `address ${m[1]}`);
  assert.doesNotMatch(fixtures, /@[\w-]+\.\w+/, 'an e-mail address');
});

test('the generated files are current (run `npm run render-console`)', () => {
  assert.equal(read(script.OUT_CSS), built.css, 'src/styles/console.css is out of date');
  assert.equal(read(script.OUT_FRAGMENTS), built.fragments, 'src/console/generated/fragments.json is out of date');
  const parsed = JSON.parse(built.fragments) as { frame: string };
  assert.equal(parsed.frame, built.frame);
});

test('the frame stays inside its size budget (60 KB gzipped, plan section 9)', () => {
  const gz = gzipSync(built.css).length + gzipSync(built.fragments).length;
  assert.ok(gz < 60 * 1024, `${gz} bytes gzipped`);
});

test('the captions and the example badge are in the frame; nothing claims to be live', () => {
  for (const t of EN.tabs) assert.ok(built.frame.includes(t.caption), `caption for ${t.id}`);
  assert.ok(built.frame.includes(EN.badge));
  // the words a reader sees or hears, not attribute names (the step list has an aria-live region)
  assert.doesNotMatch(built.frame.replace(/<[^>]*>/g, ' '), /\blive\b/i);
});
