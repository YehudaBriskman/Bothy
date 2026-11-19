// Mocks for the pages outside the home page: About, Releases, Docs (index and article), Install and 404.
// Release data is from site/fixtures/releases.json (captured 2026-11-17); everything else from en.ts.
(() => {
  const { svg, ic, cube, lock, EX, st } = window.MOCK;
  const add = (s) => window.SECTIONS.push(s);
  const G = 'Other pages';

  // About -----------------------------------------------------------------------------------
  const manifesto = [
    'A shelter, kept by the people who use it.',
    'Bothy is a web console for a single machine.',
    'It finds what is running by asking Docker,',
    'shows it on one page,',
    'and gives you a reader for the files and notes kept on that machine.',
    'It does not replace your tools.',
    'It is open source, under the MIT licence.',
  ];
  const code = [
    'Leave it as you found it.',
    'Respect other users and the place.',
    'Keep numbers down.',
    'Turn no one away.',
  ];
  add({
    id: 'about',
    group: G,
    title: 'About',
    now: 'Page head ("A shelter, kept by the people who use it."), two cards (the name with the Bothy Code; the software), a trust list with link rows, a "This site" block, then the closing band.',
    weak: 'The second card is half empty; the trust section repeats the home page; long stretches of black with small grey text; the page has no picture although the story it tells is a place.',
    ref: 'Apple and Linear essays (lines that light as they cross the middle of the screen), sticky media beside scrolling text.',
    opts: [
      {
        name: 'Lines that light as you read',
        rec: true,
        cost: 'S S S M',
        why: 'Set the About text as a short manifesto in large type; each line is dim until it reaches the middle of the screen, then lights. It turns six facts into something you read slowly, without adding a word.',
        says: 'This is what we believe, one line at a time.',
        motion:
          "Scroll-linked (scroll inside the box): each line's opacity goes from 22 % to 100 % by its distance from the middle. In the site, animation-timeline: view() with entry and exit ranges. Reduced motion: all lines full.",
        style: st({ h: '400px' }),
        html: `<p class="eb">About</p><div class="man-sc mt-s" data-scroll="lines" tabindex="0" aria-label="About, scrollable"><div style="block-size:120px"></div>${manifesto.map((l) => `<p class="h2 man" data-line>${l}</p>`).join('')}<div style="block-size:160px"></div></div>`,
      },
      {
        name: 'The name and the software, face to face',
        cost: 'S S S S',
        why: 'Two equal halves that meet at a hairline: on the left the hut (what a bothy is, the four rules ticked), on the right the software (one console for one machine). Each half fills, so neither card looks empty.',
        says: 'The software borrows the name and the manners.',
        motion:
          'On entering view: the halves slide in from their own sides (28 px, 700 ms emphasised); the hairline draws down; the four rules tick 150 ms apart. Reduced motion: still.',
        style: st({ h: '400px' }),
        html: `<div class="face"><div class="col a-lf"><p class="eb">The name</p><p class="h3">What a bothy is</p><p class="sm">A basic shelter in the hills: four walls and a roof, no charge and nobody at the door. Volunteers keep them up.</p><ul>${code.map((c, i) => `<li class="row"><span class="tk a-pop" style="--w:.6s;--d:${i};--st:.15s">✓</span><span class="sm" style="color:var(--text)">${c}</span></li>`).join('')}</ul></div>
          <span class="vline a-sy" style="--t:.6s" aria-hidden="true"></span>
          <div class="col a-rt"><p class="eb">The software</p><p class="h3">One console for one machine</p><p class="sm">It does not replace your tools. It shows and looks after what you already run.</p><p class="sm">The software borrows the name and the manners.</p><span class="pill" style="inline-size:max-content">Read the guide →</span></div></div>`,
      },
      {
        name: 'A window that follows the story',
        cost: 'M M M S',
        why: 'A tall photo window stays beside the text while you read; it changes from day to dusk to night as you pass the name, the software and "this site". The page finally has a picture, and it is the same sky as the home page.',
        says: 'Same place, different hours.',
        motion:
          'Scroll-linked (scroll inside the box): the window is sticky; the photograph crossfades (opacity, 600 ms) when the next part reaches the middle. Reduced motion: one still photograph.',
        style: st({ h: '400px' }),
        html: `<div class="sticky-sc" data-scroll="rail" tabindex="0" aria-label="About, scrollable"><div class="sw-win" aria-hidden="true"><span style="--img:var(--day)"></span><span style="--img:var(--dusk)"></span><span style="--img:var(--night)"></span>${cube(48)}</div>
          <div class="sw-text">${[
            [
              'The name',
              'What a bothy is',
              'In the hills of Scotland, and of northern England and Wales, a bothy is a basic shelter: four walls and a roof, no charge and nobody at the door.',
            ],
            [
              'The software',
              'One console for one machine',
              'It does not replace your tools. It shows and looks after what you already run.',
            ],
            [
              'This site',
              'Nothing about your visit leaves your browser.',
              'No page here makes a request to another site or sets a cookie.',
            ],
          ]
            .map(
              (s) =>
                `<section data-step class="sw-step"><p class="eb">${s[0]}</p><p class="h3 mt-s">${s[1]}</p><p class="sm mt-s">${s[2]}</p></section>`,
            )
            .join('')}<div style="block-size:120px"></div></div></div>`,
      },
    ],
  });

  // Releases ---------------------------------------------------------------------------------
  const rel = [
    [
      'v2026.11.2',
      'November 17, 2026',
      7,
      { feat: 0, fix: 2, docs: 2, other: 3 },
      [
        'docs(plans): a Bothy website, served by the box and published (later)',
        'chore(installer): pin v2026.11.1 and its checksums hash',
        'docs(plans): website follows WindoM’s model; domain bothybox.com',
      ],
    ],
    [
      'v2026.11.1',
      'November 17, 2026',
      16,
      { feat: 8, fix: 0, docs: 5, other: 3 },
      ['docs(plans): record the owner’s acceptance of D15-D28', 'chore(installer): pin v2026.11.0'],
    ],
    [
      'v2026.11.0',
      'November 16, 2026',
      83,
      { feat: 3, fix: 11, docs: 12, other: 57 },
      [
        'fix(upgrade): our own images are rebuilt on upgrade - and CI proves it',
        'release: the installer serves v2026.9.0',
      ],
    ],
    [
      'v2026.9.0',
      'September 18, 2026',
      39,
      { feat: 11, fix: 15, docs: 8, other: 5 },
      [
        'docs(plans): the master plan for all fourteen open issues',
        'fix(settings): say that a theme you wrote is a file, not a browser key',
      ],
    ],
    ['v2026.8.1', 'August 19, 2026', 0, { feat: 0, fix: 0, docs: 0, other: 0 }, []],
  ];
  const changes = (r) =>
    r[4].length
      ? `<ul class="sm">${r[4].map((c) => `<li class="row mono" style="font-size:12px">${c}</li>`).join('')}${r[2] > r[4].length ? `<li class="sm">and ${r[2] - r[4].length} more</li>` : ''}</ul>`
      : '<p class="sm">No change list was published for this release.</p>';
  add({
    id: 'releases',
    group: G,
    title: 'Releases (changelog)',
    now: 'Page head, then one card per release with every change listed in full (83 lines for v2026.11.0), the release page and comparison links; the closing band after.',
    weak: 'The page is about 8,700 px tall at desktop width, almost all of it one release; nothing gives the shape of a release (how big, what kind) before you read every line; the newest release looks like every other.',
    ref: 'Linear changelog (dates in a gutter, sticky labels), Zed releases (plain list), GitHub release pages.',
    opts: [
      {
        name: 'Timeline with folded releases',
        rec: true,
        cost: 'S S S S',
        why: 'A vertical rail with one dot per release; the newest is open and its dot glows, the older ones are folded to one line with their size ("83 changes"). Native details elements, so it works with no script and the keyboard.',
        says: 'Steady releases; here is the latest.',
        motion:
          'On entering view: the rail draws down (800 ms), entries fade in 80 ms apart, the newest dot pulses twice. Opening a release: its list fades and rises 6 px (220 ms). Reduced motion: still.',
        style: st({ h: '460px' }),
        html: `<p class="h2">Releases</p><ol class="tl-list mt"><span class="tl-rail a-sy" style="--t:.8s" aria-hidden="true"></span>${rel.map((r, i) => `<li class="a-fade" style="--d:${i}"><span class="tl-dot ${i ? '' : 'on'}" aria-hidden="true">${i ? '' : '<i class="lp-pulse"></i>'}</span><details ${i ? '' : 'open'}><summary><b class="mono">${r[0]}</b>${i ? '' : ' <span class="chip ok">Newest</span>'} <span class="sm">${r[1]} · ${r[2]} change${r[2] === 1 ? '' : 's'}</span></summary><div class="tl-body">${changes(r)}</div></details></li>`).join('')}</ol>`,
      },
      {
        name: 'Release cards with their shape',
        cost: 'S S S S',
        why: 'Each release opens with a bar showing what kind of changes it carried (features, fixes, docs, other), counted from the real release notes, so you see at once that 2026.11.0 was a big one and 2026.11.2 a small fix.',
        says: 'What changed, at a glance.',
        motion:
          'On entering view: each bar grows from the start edge (scaleX, 700 ms emphasised, 100 ms apart); the counts fade in after. Reduced motion: still.',
        style: st({ h: '460px' }),
        html: `<p class="h2">Releases</p><p class="flex sm mt-s"><span class="lgd k-f">features</span><span class="lgd k-x">fixes</span><span class="lgd k-d">docs</span><span class="lgd k-o">other</span></p><ul class="col mt">${rel
          .slice(0, 4)
          .map(
            (r, i) =>
              `<li class="card pad-s"><p class="flex btw"><b class="mono">${r[0]}</b><span class="sm">${r[1]} · ${r[2]} changes</span></p><span class="shape a-sx" style="--d:${i};--st:.1s">${['feat', 'fix', 'docs', 'other'].map((k, j) => (r[3][k] ? `<i class="k-${'fxdo'[j]}" style="flex:${r[3][k]}" title="${r[3][k]} ${k}"></i>` : '')).join('')}</span></li>`,
          )
          .join(
            '',
          )}</ul><p class="sm mt-s">Counted from each change's prefix in the real notes (feat, fix, docs; the rest is "other").</p>`,
      },
      {
        name: 'Sticky version gutter',
        cost: 'S S S S',
        why: "Two columns: the version and date stick in a narrow gutter while that release's changes scroll past on the right, so you never lose which release a line belongs to on a long list.",
        says: 'A careful, complete record.',
        motion:
          'Scroll (inside the box): the gutter label is position: sticky; the next label pushes it up. Lines fade in as they enter (in the site, a view() timeline). No other motion. Reduced motion: unchanged (sticky is not motion).',
        style: st({ h: '420px' }),
        html: `<div class="gut-sc" tabindex="0" aria-label="Releases, scrollable">${rel
          .slice(0, 4)
          .map(
            (r) =>
              `<section class="gut"><div class="gut-l"><b class="mono">${r[0]}</b><p class="sm">${r[1]}</p></div><div>${changes(r)}<div style="block-size:90px"></div></div></section>`,
          )
          .join('')}</div>`,
      },
    ],
  });

  // Docs index --------------------------------------------------------------------------------
  const docs = [
    [
      'Getting it running',
      'run',
      ['The Bothy guide', 'Installing Bothy', 'The bothy command', 'Upgrading', 'The files you will actually edit'],
    ],
    [
      'Using it',
      'use',
      [
        'Operating it from the console',
        'Adding a service to the stack',
        'Bothy Files',
        'Declaring a project',
        'Themes',
      ],
    ],
    ['Operating it', 'ops', ['Monitoring', 'Roles', 'Settings', 'When something is wrong']],
  ];
  const all = docs.flatMap((g) => g[2].map((t) => [t, g[1], g[0]]));
  add({
    id: 'docs-index',
    group: G,
    title: 'Docs index',
    now: 'Page head with two notes, a left list of all pages, a search field, then three groups of two-column cards, each card a title and a truncated excerpt.',
    weak: 'Every page is listed twice (sidebar and cards); the excerpts are cut mid-sentence ("will actual…"); search sits below the fold on a phone; nothing says where to start.',
    ref: 'Resend docs (organised by task), Supabase and Tailscale docs (search first, product cards), command-palette search.',
    opts: [
      {
        name: 'Search first',
        rec: true,
        cost: 'M S S S',
        why: 'Put a large search field at the top with a "/" shortcut, and under it the three groups as tight lists, not cards. Typing filters the list in place. It is the fastest way to a page and the index stays one screen tall.',
        says: 'You know what you want; type it.',
        motion:
          "Typing: rows that do not match fade to 18 % and shrink to 97 % (250 ms); the count updates. Focus: the field's ring grows in 150 ms. Reduced motion: instant.",
        style: st({ h: '420px' }),
        html: `<div data-search><p class="h2">Documentation</p><label class="srch mt"><span class="sr-only-v">Search the docs</span>${svg('search')}<input type="search" placeholder="Search the docs" aria-label="Search the docs" /><span class="kbd">/</span></label><p class="sm mt-s" data-count aria-live="polite">14 pages</p>
          <div class="g3 mt-s flt">${docs.map((g) => `<div><p class="eb">${g[0]}</p><ul class="mt-s">${g[2].map((t) => `<li data-t="${t}" data-k="x"><a class="lk" href="#docs-index">${t}<span class="ar">→</span></a></li>`).join('')}</ul></div>`).join('')}</div></div>`,
      },
      {
        name: 'Three doors',
        cost: 'S S S M',
        why: 'Three tall cards, one per group, each with an icon, a one-line purpose and its pages as links. A newcomer reads three sentences and knows which door is theirs; the spotlight makes the cards feel like doors.',
        says: 'Start here, then here, then here.',
        motion:
          'On entering view: cards rise 90 ms apart. Pointer: the spotlight edge follows across the three (no loop); keyboard focus lights the focused card. Reduced motion: still.',
        style: st({ h: '400px' }),
        html: `<p class="h2">Documentation</p><ul class="g3 mt" data-spot>${docs.map((g, i) => `<li class="card pad spot a-up" style="--d:${i};--st:.09s">${ic(['term', 'grid', 'shield'][i])}<p class="h3 mt-s">${g[0]}</p><p class="sm">${['Install it and know which files matter.', 'Use the console, the reader and themes.', 'Keep it healthy and know who may do what.'][i]}</p><ul class="mt-s">${g[2].map((t) => `<li><a class="flink" href="#docs-index">${t}</a></li>`).join('')}</ul></li>`).join('')}</ul>`,
      },
      {
        name: 'I want to…',
        cost: 'S S S S',
        why: 'A row of task chips ("install it", "use it", "run it day to day", "fix something") over the full card grid; a chip brings its pages forward and quiets the rest. Organised by what the reader is trying to do, not by our chapters.',
        says: 'Tell us what you are doing.',
        motion:
          'Click a chip: the pressed chip fills (150 ms); cards outside the task fade to 18 % and shrink to 97 % (250 ms ease-out), so the layout never jumps. Reduced motion: instant.',
        style: st({ h: '420px' }),
        html: `<div data-filter class="flt"><p class="h2">Documentation</p><p class="flex wrap mt" role="group" aria-label="I want to">${[
          ['all', 'Everything'],
          ['run', 'Install it'],
          ['use', 'Use it'],
          ['ops', 'Run it day to day'],
          ['fix', 'Fix something'],
        ]
          .map(
            (c, i) =>
              `<button type="button" class="chip fchip" data-f="${c[0]}" aria-pressed="${i === 0}">${c[1]}</button>`,
          )
          .join('')}</p>
          <ul class="g4 mt-s">${all.map((d) => `<li class="card pad-s" data-k="${d[1]}${d[0] === 'When something is wrong' || d[0] === 'Upgrading' ? ' fix' : ''}"><b class="sm" style="color:var(--text)">${d[0]}</b><p class="sm">${d[2]}</p></li>`).join('')}</ul></div>`,
      },
    ],
  });

  // Docs article ------------------------------------------------------------------------------
  const art = [
    [
      'The Overview',
      'Ordered by the question it answers, largest type first: a status line, the attention strip, the system matrix, then vitals. Everything on this page was discovered by asking Docker.',
    ],
    [
      'Control',
      'Control opens on a triage page that says nothing at all when there is nothing to say. When there is, it names three classes of problem that appear nowhere else in one place.',
    ],
    [
      'The three verbs',
      'Bothy Control does exactly three things to a container: restart, stop and start. The result is reported as a transition, from state to state, and how long the daemon took.',
    ],
    [
      'What it will not do',
      'There is no exec and no shell in the browser. Creating, removing, pulling images and managing volumes stay with the Docker command line.',
    ],
    ['Settings', 'Three groups, and only one of them changes anything: you, appearance, and where these are kept.'],
  ];
  const toc = `<nav class="toc" aria-label="On this page"><p class="eb">On this page</p><span class="spy-ind" aria-hidden="true"></span>${art.map((a, i) => `<a href="#docs-article" data-to="${i}">${a[0]}</a>`).join('')}</nav>`;
  const body = (cls = '') =>
    `<p class="sm">Documentation / Using it</p><p class="h2 ${cls}">Operating it from the console</p>${art.map((a) => `<section data-sec><p class="h3 mt">${a[0]}</p><p class="p mt-s">${a[1]}</p></section>`).join('')}<div style="block-size:220px"></div>`;
  add({
    id: 'docs-article',
    group: G,
    title: 'Docs article',
    now: 'Three columns: the docs list on the left, the article in the middle (tables, code, long sections), "On this page" on the right; a previous and next pager at the end.',
    weak: 'The right-hand contents never shows where you are; long pages (about 6,500 px) give no sense of progress; tables are dense grey boxes; the left list repeats the whole docs index on every page.',
    ref: 'Supabase and Ghostty docs (scroll-spy contents), Tailscale knowledge base (breadcrumbs, last updated), Vercel docs (reading progress).',
    opts: [
      {
        name: 'Contents that follow you',
        rec: true,
        cost: 'S S S S',
        why: 'Keep the three columns, and make "On this page" a real guide: a small marker slides to the section you are reading. The cheapest change that makes long pages feel shorter.',
        says: 'You are here.',
        motion:
          'Scroll (inside the box): the marker moves to the active link with transform, 220 ms ease-out; the active link brightens. Reduced motion: the marker jumps.',
        style: st({ h: '400px' }),
        html: `<div class="art3"><nav class="art-nav sm" aria-label="Docs"><p class="eb">Using it</p>${['Operating it from the console', 'Adding a service', 'Bothy Files', 'Declaring a project', 'Themes'].map((t, i) => `<a href="#docs-article" class="flink"${i ? '' : ' aria-current="page"'}>${t}</a>`).join('')}</nav><div class="art-sc" data-scroll="spy" tabindex="0" aria-label="Article, scrollable">${body()}</div>${toc}</div>`,
      },
      {
        name: 'Reading progress and calm tables',
        cost: 'S S S S',
        why: 'A one-pixel amber line along the top shows how far through the page you are; tables become two-column lists with the route in mono and the meaning beside it. Long, dense pages become easier to keep going on.',
        says: 'Nearly there.',
        motion:
          'Scroll-linked: the top line scales from 0 to 100 % across the page (in the site, animation-timeline: scroll(), no script). Reduced motion: unchanged (it reports position, it does not move things).',
        style: st({ h: '400px' }),
        html: `<div class="prog prog-top"><i></i></div><div class="art-sc solo" data-scroll="spy" tabindex="0" aria-label="Article, scrollable"><p class="h2">Operating it from the console</p>
          <dl class="dl mt">${[
            ['/', 'Overview: the box at a glance, and the front door'],
            ['/control', 'Control: triage, then Services, Ports, Routes and Topology'],
            ['/files', 'Bothy Files: every document on the box, rendered'],
            ['/settings', 'reachable from the person menu rather than the nav'],
          ]
            .map((r) => `<div class="row"><dt class="mono">${r[0]}</dt><dd class="sm">${r[1]}</dd></div>`)
            .join(
              '',
            )}</dl>${art.map((a) => `<section data-sec><p class="h3 mt">${a[0]}</p><p class="p mt-s">${a[1]}</p></section>`).join('')}<div style="block-size:220px"></div></div><span class="spy-ind" hidden></span>`,
      },
      {
        name: 'One column, contents on demand',
        cost: 'M S S M',
        why: 'Hide both side columns behind one "Contents" button and set the article in a single readable measure; heading anchors appear on hover or focus. Best on a phone, and calmer for long reading on a laptop.',
        says: 'Just the text.',
        motion:
          'Contents button: a panel drops 8 px and fades in (180 ms ease-out), items 30 ms apart; Escape and the button close it. Anchors fade in on hover or focus (150 ms). Reduced motion: no drop.',
        style: st({ h: '400px' }),
        html: `<div class="flex btw"><p class="sm">Documentation / Using it</p><button type="button" class="pill" data-dd aria-expanded="false" aria-controls="toc-c">Contents</button></div>
          <div class="gl pad toc-pop" id="toc-c" hidden>${art.map((a, i) => `<a class="flink a-drop" style="--d:${i};--st:.03s" href="#docs-article">${a[0]}</a>`).join('')}</div>
          <div class="measure"><p class="h2">Operating it from the console</p>${art
            .slice(0, 3)
            .map(
              (a) =>
                `<p class="h3 mt anch"><a href="#docs-article" class="hash" aria-label="Link to ${a[0]}">#</a>${a[0]}</p><p class="p mt-s">${a[1]}</p>`,
            )
            .join('')}</div>`,
      },
    ],
  });

  // Install page --------------------------------------------------------------------------------
  const arch = [
    ['linux/amd64', 'Run end to end in the lab', '3.6 MB', 'ok'],
    ['linux/arm64', 'Built, never run', '3.2 MB', 'pl'],
    ['darwin/amd64', 'Command-line client only', '3.6 MB', ''],
    ['darwin/arm64', 'Command-line client only', '3.3 MB', ''],
    ['windows/amd64', 'Command-line client only', '3.7 MB', ''],
    ['windows/arm64', 'Command-line client only', '3.3 MB', ''],
  ];
  const pstep = [
    ['Download the archive and the checksums', 'curl -fsSLO …/bothy_2026.11.2_linux_amd64.tar.gz'],
    ['Verify what you downloaded', 'sha256sum --ignore-missing -c checksums.txt'],
    ['Put it on your path', 'install -D bothy ~/.local/bin/bothy'],
    ['Read the plan, then install', 'bothy install --dry-run && bothy install'],
  ];
  add({
    id: 'install-page',
    group: G,
    title: 'Install page',
    now: 'A long single page: "Pick a path" (two cards), requirements, "run it as your normal user", Path 1 in four numbered steps with terminals, Path 2, updating and uninstalling, the two proof lists, the archive table, "not offered yet".',
    weak: 'About 7,000 px of mostly text; the choice between the two paths is made at the top and then both are shown anyway; the archive table is the only place the platforms are explained and it is at the bottom.',
    ref: 'Zed and Ghostty download pages (platform first), stepper patterns, Fly.io install docs.',
    opts: [
      {
        name: 'Pick a path, see only that path',
        rec: true,
        cost: 'M S S S',
        why: "The two path cards become the switch: choosing one shows its steps and hides the other's. Without script both paths stay on the page in order, as now. Halves the page for everyone.",
        says: 'There are two ways; you only need one.',
        motion:
          'Click or arrow keys: the chosen card lifts and its edge lights (220 ms); the steps crossfade and rise 8 px (280 ms). Reduced motion: instant.',
        style: st({ h: '460px' }),
        html: `<div data-tabs><p class="h2">Install Bothy</p><div role="tablist" aria-label="Pick a path" class="g2 mt paths">${[
          [
            'The release binary',
            'Tested in our lab',
            'Download bothy, verify it, run bothy install. Bivvy: three containers.',
          ],
          [
            'A source checkout',
            'The development stack',
            'Clone the repository and run its own just recipes. The full stack, not the small one.',
          ],
        ]
          .map(
            (p, i) =>
              `<button role="tab" type="button" class="card pad pathc" aria-selected="${i === 0}"><span class="chip ${i ? '' : 'ok'}">${p[1]}</span><b class="h3" style="display:block;margin-block-start:8px">${p[0]}</b><span class="sm" style="display:block">${p[2]}</span></button>`,
          )
          .join('')}</div>
          <div class="mt" style="position:relative"><ol data-panel="0">${pstep.map((s, i) => `<li class="row"><span class="rn">${i + 1}</span><span class="gr"><b class="sm" style="color:var(--text)">${s[0]}</b><br><span class="mono sm">${s[1]}</span></span></li>`).join('')}</ol>
          <ol data-panel="1" hidden>${['git clone the repository && cd Bothy', 'just doctor', 'just up'].map((s, i) => `<li class="row"><span class="rn">${i + 1}</span><span class="mono sm gr">${s}</span></li>`).join('')}<li class="sm">The full development stack; bothy install does not manage it.</li></ol></div></div>`,
      },
      {
        name: 'A stepper you tick off',
        cost: 'M S S M',
        why: 'The four steps of Path 1 as a checklist: each has its command, a copy button and a "Done" box you tick yourself; a progress line fills. Kept only in the page, nothing stored. It holds your place in a long install.',
        says: 'You are two steps from done.',
        motion:
          'Tick: the box fills (150 ms), the progress line grows to the new fraction (scaleX, 400 ms emphasised), the step dims. Reduced motion: instant.',
        style: st({ h: '440px' }),
        html: `<div data-steps class="steps"><div class="flex btw"><p class="h2">Path 1: the release binary</p><span class="sm" data-count aria-live="polite"></span></div><div class="prog mt-s"><i></i></div>
          <ol class="mt">${pstep.map((s, i) => `<li class="row stp"><span class="rn">${i + 1}</span><span class="gr"><b class="sm" style="color:var(--text)">${s[0]}</b><span class="code flex btw mt-s" style="padding:6px 10px"><span class="ell">${s[1]}</span><button type="button" class="pill" data-copy="${s[1]}">Copy</button></span></span><label class="sm done"><input type="checkbox" /> Done</label></li>`).join('')}</ol></div>`,
      },
      {
        name: 'Platforms first',
        cost: 'S S S S',
        why: 'Open with the six archives as tiles: Linux amd64 lit and marked "Run end to end in the lab", Linux arm64 dashed "Built, never run", the rest "Command-line client only". The honest platform story is the first thing anyone sees.',
        says: 'Here is exactly what works where.',
        motion:
          'On entering view: tiles pop from 96 %, 60 ms apart, the tested tile last with a ring that pulses twice. Hover or focus raises a tile 3 px. Reduced motion: still.',
        style: st({ h: '400px' }),
        html: `<p class="h2">Which archive</p><p class="p mt-s">Every release carries these. Only the first is shown to run a stack.</p><ul class="g3 mt">${arch.map((a, i) => `<li class="card pad-s tile ${a[3]} a-pop" style="--s:.96;--d:${i === 0 ? 6 : i};--st:.06s"><p class="flex btw"><b class="mono">${a[0]}</b><span class="sm">${a[2]}</span></p><p class="sm mt-s">${a[3] === 'ok' ? '<span class="ok-t">✓ </span>' : a[3] === 'pl' ? '○ ' : ''}${a[1]}</p>${a[3] === 'ok' ? '<i class="ring lp-pulse" aria-hidden="true"></i>' : ''}</li>`).join('')}</ul><p class="sm mt-s">Release 2026.11.2. Sizes rounded.</p>`,
      },
    ],
  });

  // 404 -------------------------------------------------------------------------------------------
  const pages = [
    'Home',
    'Install',
    'Docs',
    'Releases',
    'About',
    'Installing Bothy',
    'The bothy command',
    'Operating it from the console',
    'Bothy Files',
    'When something is wrong',
  ];
  add({
    id: 'not-found',
    group: G,
    title: '404',
    now: 'Eyebrow "404", heading "No page here", one sentence, "Try one of these" and four pills, on black.',
    weak: 'Correct and plain; nothing of the brand or the sky; no way to search for the page you meant.',
    ref: 'GitHub, Vercel and Fly.io 404s (brand mark, one way home), docs sites that put search on the 404.',
    opts: [
      {
        name: 'Lost in the cloud',
        rec: true,
        cost: 'S S S S',
        why: 'The same words, set over a cloud photograph with a little mist drifting and the Cube floating, as if the page wandered off the path. Brand, sky and a smile, at the cost of one image already cached.',
        says: 'Wrong turn, no harm done.',
        motion:
          'Loop while visible: the mist layer drifts 6 % sideways over 26 s and back; the Cube bobs 8 px over 6 s. Pills rise on load. Reduced motion: still mist, still Cube.',
        cls: 'sky',
        style: st({ img: 'var(--cumulus)', h: '360px' }),
        html: `<span class="mist lp-drift" aria-hidden="true"></span><div class="col" style="max-inline-size:520px"><span class="lp-float" style="inline-size:max-content">${cube(46)}</span><p class="eb">404</p><p class="h2">No page here</p><p class="p">That address is not part of this site. It may have moved, or it may never have existed.</p><p class="flex wrap a-up" style="--w:.2s"><span class="pill lit">Home</span><span class="pill">Install</span><span class="pill">Docs</span><span class="pill">Releases</span></p></div>`,
      },
      {
        name: 'Search from here',
        cost: 'M S S S',
        why: 'Most people who land on a 404 were looking for something specific; give them the site search right there, with the main pages listed and filtered as they type.',
        says: 'Let us find what you meant.',
        motion:
          'Field focused on arrival (no motion). Typing: rows fade and shrink as they stop matching (250 ms). Reduced motion: instant.',
        style: st({ h: '360px' }),
        html: `<div data-search class="split" style="align-items:start"><div><p class="eb">404</p><p class="h2 mt-s">No page here</p><p class="p mt-s">That address is not part of this site. Search for the page you meant.</p></div><div><label class="srch">${svg('search')}<input type="search" placeholder="Search this site" aria-label="Search this site" /></label><p class="sm mt-s" data-count aria-live="polite">10 pages</p><ul class="flt">${pages.map((p) => `<li data-t="${p}" data-k="x"><a class="lk" href="#not-found">${p}<span class="ar">→</span></a></li>`).join('')}</ul></div></div>`,
      },
      {
        name: 'The compass',
        cost: 'S S S S',
        why: "A small compass whose needle swings, overshoots and settles pointing at the Home button. A hillwalker's joke that fits the bothy, and it draws the eye to the one action that matters.",
        says: 'This way home.',
        motion:
          'On load, once: the needle rotates from -120 degrees, overshoots to 38, settles in 1.6 s (damped keyframes); the Home pill fades in as it settles. Reduced motion: needle already pointing.',
        style: st({ h: '340px' }),
        html: `<div class="split"><div class="compass" aria-hidden="true"><span class="needle a-swing" style="--t:1.6s;--e:ease-out"></span><b>N</b></div><div class="col"><p class="eb">404</p><p class="h2">No page here</p><p class="p">It may have moved, or it may never have existed.</p><p class="flex"><span class="pill lit a-fade" style="--w:1.2s">Home →</span><span class="pill">Docs</span></p></div></div>`,
      },
    ],
  });
})();
