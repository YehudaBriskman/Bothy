// Mocks for the home page sections. Words are the site's own (site/src/i18n/en.ts) or the measured facts in
// site/src/facts.ts; anything invented is marked EXAMPLE. Each option: name, why, says, motion, cost
// ("Effort Risk Perf A11y", each S, M or L), html, and optional cls/style for its stage.
window.SECTIONS = [];
(() => {
  const P = {
    shield: '<path d="M12 3l7 3v5c0 5-3.5 8.5-7 10-3.5-1.5-7-5-7-10V6z"/><path d="M9 12l2 2 4-4"/>',
    repeat:
      '<path d="M17 2l3 3-3 3"/><path d="M4 11V9a4 4 0 0 1 4-4h12"/><path d="M7 22l-3-3 3-3"/><path d="M20 13v2a4 4 0 0 1-4 4H4"/>',
    alert: '<circle cx="12" cy="12" r="9"/><path d="M12 8v4M12 16h.01"/>',
    home: '<path d="M4 11l8-7 8 7v9H4z"/><path d="M10 20v-5h4v5"/>',
    file: '<path d="M14 3H7a2 2 0 0 0-2 2v14a2 2 0 0 0 2 2h10a2 2 0 0 0 2-2V8z"/><path d="M14 3v5h5"/>',
    grid: '<rect x="4" y="4" width="7" height="7" rx="1.5"/><rect x="13" y="4" width="7" height="7" rx="1.5"/><rect x="4" y="13" width="7" height="7" rx="1.5"/><rect x="13" y="13" width="7" height="7" rx="1.5"/>',
    users:
      '<circle cx="9" cy="8" r="3.5"/><path d="M3 20c0-3.5 2.7-6 6-6s6 2.5 6 6"/><path d="M16 4.5a3.5 3.5 0 0 1 0 7M18 14c2 .8 3 3 3 6"/>',
    palette:
      '<circle cx="12" cy="12" r="9"/><circle cx="8" cy="10" r="1.2"/><circle cx="12" cy="7.5" r="1.2"/><circle cx="16" cy="10" r="1.2"/>',
    arrow: '<path d="M5 12h14M13 6l6 6-6 6"/>',
    code: '<path d="M8 6l-6 6 6 6M16 6l6 6-6 6"/>',
    tag: '<path d="M3 12V4h8l10 10-8 8z"/><circle cx="7.5" cy="7.5" r="1.3"/>',
    term: '<rect x="3" y="4" width="18" height="16" rx="2"/><path d="M7 9l3 3-3 3M12 15h5"/>',
    book: '<path d="M4 5a2 2 0 0 1 2-2h13v16H6a2 2 0 0 0-2 2z"/><path d="M4 21V5"/>',
    search: '<circle cx="11" cy="11" r="7"/><path d="M20 20l-4-4"/>',
    lock: '<rect x="5" y="11" width="14" height="10" rx="2"/><path d="M8 11V8a4 4 0 0 1 8 0v3"/>',
    down: '<path d="M6 9l6 6 6-6"/>',
  };
  const svg = (n, extra = '') => `<svg viewBox="0 0 24 24" aria-hidden="true" ${extra}>${P[n]}</svg>`;
  const ic = (n, c = '') => `<span class="ico ${c}" aria-hidden="true">${svg(n)}</span>`;
  const cube = (s = 22, lid = '') =>
    `<svg class="cubesvg" width="${s}" height="${s}" viewBox="0 0 64 64" aria-hidden="true"><path fill="#f3f2ee" d="M8 18L32 30V58L8 46Z"/><path fill="#f3f2ee" opacity=".72" d="M32 30L56 18V46L32 58Z"/><path class="${lid}" fill="#ffd58a" d="M32 6L56 18L32 30L8 18Z"/></svg>`;
  const lock = (s = 18) => `<span class="lockup">${cube(s)}<b>BothyBox</b></span>`;
  const EX = '<span class="ex">EXAMPLE</span>';
  const st = (o) =>
    Object.entries(o)
      .map(([k, v]) => `--${k}:${v}`)
      .join(';');
  window.MOCK = { svg, ic, cube, lock, EX, st };
  const add = (s) => window.SECTIONS.push(s);
  const H = 'Home page';

  // Shared fragments ---------------------------------------------------------
  const navLinks = ['Docs', 'Install', 'Modes', 'Releases', 'About'];
  const installPanel = (cls = 'a-drop') => `
    <p class="eb" style="--d:0" >Tested in our lab</p>
    <div class="row ${cls}" style="--d:1"><span class="ico">${svg('term')}</span><span class="gr"><b>Linux, amd64</b><br><span class="sm">The release binary, run end to end</span></span><span class="chip ok">Tested</span></div>
    <div class="row ${cls}" style="--d:2"><span class="ico">${svg('grid')}</span><span class="gr"><b>Docker with Compose v2</b><br><span class="sm">What the stack runs on; the installer checks it</span></span><span class="chip">Needed</span></div>
    <div class="code flex btw ${cls}" style="--d:3"><span>bothy install --dry-run</span><button class="pill" data-copy="bothy install --dry-run" type="button">Copy</button></div>
    <p class="sm ${cls}" style="--d:4">Not yet: macOS, Windows and Linux on arm64 are not built or tested as a place to run it.</p>`;
  const services = [
    ['edge', 'serves the pages'],
    ['console', 'the web console'],
    ['files', 'the notes reader'],
  ];

  // 01 Nav ------------------------------------------------------------------
  add({
    id: 'nav',
    group: H,
    title: 'Navigation and the install dropdown',
    now: 'Lockup left, five text links in the middle, a GitHub pill and a split "Install" pill on the right; the chevron opens a glass panel (platforms, the dry-run command, three links).',
    weak: 'The bar is full width and heavy over the sky; the links are plain text with no hover state you can see; the panel is a long single column and appears with no sense of where it came from.',
    opts: [
      {
        name: 'Condensing capsule',
        rec: true,
        cost: 'S S S S',
        why: 'Over the hero the bar is nothing but text on the sky; once you scroll it gathers into one centred glass capsule, so the sky stays clean and the nav is still always there.',
        says: 'Quiet, careful, out of the way.',
        motion:
          'Scroll-linked over the first 120 px: background 0 to glass, scale 1 to 0.9, links pull in. Dropdown: 180 ms, ease-out, fade plus 6 px drop, rows staggered 30 ms. Reduced motion: the capsule state, no drop.',
        cls: 'sky',
        style: st({ img: 'var(--day)', h: '330px' }),
        html: `<div class="nav-cap a-cond" style="--t:1.1s">${lock()}<nav class="nav-l" aria-label="Example">${navLinks.map((l) => `<a href="#nav">${l}</a>`).join('')}</nav><span class="flex"><span class="pill">GitHub</span><span class="spl"><span class="pill lit">Install</span><button type="button" class="pill lit chev" data-dd aria-expanded="true" aria-controls="dd-a" aria-label="Install options">${svg('down')}</button></span></span></div>
          <div class="gl pad dd" id="dd-a">${installPanel()}</div>`,
      },
      {
        name: 'Two-column install panel',
        cost: 'M S S S',
        why: 'The dropdown is the shortest path to installing. Laid out wide, platforms on one side and the command on the other, it reads in one glance instead of a scroll.',
        says: 'This is exactly what runs where, and here is the command.',
        motion:
          'Click: panel 200 ms ease-out from the button (scale 0.97 to 1, origin top right). Left rows stagger 40 ms; the command types itself once (45 ms a character), then the caret rests.',
        style: st({ h: '330px' }),
        html: `<div class="nav-bar">${lock()}<nav class="nav-l" aria-label="Example">${navLinks.map((l) => `<a href="#nav">${l}</a>`).join('')}</nav><span class="spl"><span class="pill lit">Install</span><span class="pill lit chev">${svg('down')}</span></span></div>
          <div class="gl pad dd2 a-pop" style="--s:.97">
            <div class="col"><p class="eb">Tested in our lab</p>
              <div class="row a-up" style="--d:1;--st:.04s"><span class="ico">${svg('term')}</span><span class="gr"><b>Linux, amd64</b><br><span class="sm">The release binary, run end to end</span></span><span class="chip ok">Tested</span></div>
              <div class="row a-up" style="--d:2;--st:.04s"><span class="ico">${svg('grid')}</span><span class="gr"><b>Docker with Compose v2</b><br><span class="sm">The installer checks it</span></span><span class="chip">Needed</span></div>
              <p class="sm">Not yet: macOS, Windows and Linux on arm64.</p></div>
            <div class="col"><p class="eb">Read the plan first</p>
              <div class="code"><span class="pr">$ </span><span class="tw" style="--n:23;--w:.3s">bothy install --dry-run</span><span class="caret"></span></div>
              <a class="lk" href="#nav">Installing guide <span class="ar">→</span></a><a class="lk" href="#nav">Release notes <span class="ar">→</span></a></div>
          </div>`,
      },
      {
        name: 'Sliding hover pill',
        cost: 'S S S S',
        why: 'A soft glass pill slides under whichever link you point at or tab to, so the nav answers the pointer and the keyboard the same way; the panel grows out of the button that opened it.',
        says: 'Responsive and precise, like the console itself.',
        motion:
          'Pointer or focus: the pill moves in 320 ms on the emphasised curve (transform and width). Dropdown: scale 0.9 to 1 from the button corner, 220 ms, with a 12 px blur-free fade. Reduced motion: the pill jumps.',
        style: st({ h: '330px' }),
        html: `<div class="nav-bar">${lock()}<nav class="nav-l tabs" data-hl aria-label="Example"><span class="ind" style="opacity:0"></span>${navLinks.map((l, i) => `<a href="#nav"${i === 1 ? ' aria-current="page"' : ''}>${l}</a>`).join('')}</nav><span class="spl"><span class="pill lit">Install</span><button type="button" class="pill lit chev" data-dd aria-expanded="true" aria-controls="dd-c" aria-label="Install options">${svg('down')}</button></span></div>
          <div class="gl pad dd a-pop" id="dd-c" style="--s:.9;transform-origin:100% 0">${installPanel('')}</div>`,
      },
    ],
  });

  // 02 Hero -----------------------------------------------------------------
  const heroBtns = (c = '') =>
    `<span class="flex wrap ${c}"><span class="spl"><span class="pill lit">Install Bothy</span><span class="pill lit chev">${svg('down')}</span></span><span class="pill">Read the docs</span></span>`;
  add({
    id: 'hero',
    group: H,
    title: 'Hero: the sky',
    now: 'A live sky photograph, a pill "Installs on Linux with Docker", a small serif BothyBox, a very large centred headline, a lede and two pills.',
    weak: 'Two names stacked (the serif BothyBox and the headline) compete; the serif mark does not match the lockup in the nav; nothing on screen shows the product; the scroll cue is weak.',
    ref: 'Zephium hero (per-word rise, chip with a moving highlight), Raycast and Linear (product shot right under the headline).',
    opts: [
      {
        name: 'Words rise, one name',
        rec: true,
        cost: 'S S S S',
        why: 'Keep the sky and the centred stack, drop the duplicate serif name for the real lockup, and let the headline arrive word by word as the sky settles. The cheapest change with the biggest calm.',
        says: 'A place, not a pitch.',
        motion:
          'Load: words rise 18 px and fade, 1.1 s emphasised, 45 ms apart; lede at 0.55 s; buttons at 0.7 s. The chip edge carries one conic highlight that turns once (4.5 s) and stops. Reduced motion: all drawn complete.',
        cls: 'sky ctr',
        style: st({ img: 'var(--day)', h: '440px' }),
        html: `<div class="col ctr" style="gap:14px;justify-items:center;align-items:center">
          <span class="chip shinebox a-up" style="--d:0"><span class="shine lp-shine" aria-hidden="true"></span>Installs on Linux with Docker ›</span>
          <span class="a-up" style="--d:1">${lock(26)}</span>
          <p class="d hero-h">${'A free shelter in the hills, for your machine.'
            .split(' ')
            .map((w, i) => `<span class="w a-up" style="--d:${i + 2};--st:.045s;--t:1.1s">${w}</span>`)
            .join(' ')}</p>
          <p class="p a-up" style="--w:.55s">One console for the machine you run things on. Free and open source.</p>
          ${heroBtns('a-up" style="--w:.7s')}
        </div>`,
      },
      {
        name: 'The lit window',
        cost: 'M M S S',
        why: 'Open on dusk, with the Cube large and its amber lid glowing like a lit window; the headline is unmasked line by line beneath it. It ties the hero to the brand splash the owner chose.',
        says: 'Somebody left the light on for you.',
        motion:
          'Load: Cube fades up, its lid glow breathes once (2.4 s); headline lines slide up out of a mask, 800 ms emphasised, 90 ms apart; buttons fade at 0.9 s. Reduced motion: still.',
        cls: 'sky ctr',
        style: st({ img: 'var(--dusk)', h: '440px' }),
        html: `<div class="col" style="align-items:center;gap:14px">
          <span class="litcube a-pop" style="--s:.8">${cube(84)}<span class="glow lp-pulse" aria-hidden="true"></span></span>
          <p class="d"><span class="mask"><span class="a-line" style="--d:2;--st:.09s;--t:.8s">A free shelter in the hills,</span></span><span class="mask"><span class="a-line" style="--d:3;--st:.09s;--t:.8s">for your machine.</span></span></p>
          <p class="p a-fade" style="--w:.7s">One console for the machine you run things on. Free and open source.</p>
          ${heroBtns('a-fade" style="--w:.9s')}
        </div>`,
      },
      {
        name: 'Split with the console rising',
        cost: 'M M M S',
        why: 'Words on the left, the real console on the right rising out of the clouds and tilting flat as you scroll. The visitor sees the product in the first screen, which none of the current hero does.',
        says: 'This is a real thing you can look at.',
        motion:
          'Load then scroll: the window starts 60 px low, tilted 22 degrees back at 94 %, and settles flat over the first screen of scroll (scroll-linked). Text rises 18 px, 80 ms apart. Reduced motion: flat and still.',
        cls: 'sky',
        style: st({ img: 'var(--cumulus)', h: '440px' }),
        html: `<div class="split" style="min-block-size:360px">
          <div class="col"><span class="chip a-up">Installs on Linux with Docker ›</span><p class="d a-up" style="--d:1;font-size:clamp(28px,5.6cqi,70px)">A free shelter in the hills, for your machine.</p><p class="p a-up" style="--d:2">One console for the machine you run things on. Free and open source.</p>${heroBtns('a-up" style="--d:3')}</div>
          <div class="gl pad a-tilt" style="--t:1.4s;--w:.2s"><div class="flex btw"><span class="flex"><i class="tl"></i><i class="tl"></i><i class="tl"></i><b class="sm" style="color:var(--text)">Overview</b></span>${EX}</div>
            <ul class="mt-s">${services.map(([n, s]) => `<li class="row"><span class="dot"></span><span class="gr"><span class="mono">${n}</span> <span class="sm">${s}</span></span><span class="sm">up</span></li>`).join('')}</ul></div>
        </div>`,
      },
    ],
  });

  // 03 Story console ----------------------------------------------------------
  const steps = [
    ['Sign in', 'Sign in with the login your realm gives you.'],
    ['Discover', 'Nothing to configure. It asks Docker what is running.'],
    ['Services', 'Every service on one page: state, ports, image.'],
    ['Open one', 'Open one to see its state, and restart or stop it.'],
    ['Health', 'One glance at whether the machine is all right.'],
    ['Files', 'Notes kept on the machine, read as documents.'],
    ['Modules', 'Add a module from the command line, and see its memory.'],
  ];
  const svcRows = [
    ['Notes web', 'Up', 'Notes app', '8081'],
    ['Notes API', 'Up', 'Notes app', '—'],
    ['Wiki', 'Starting', 'Team wiki', '8090'],
    ['Dev server', 'Unknown', 'On the host', '5173'],
    ['Nightly backup', 'Stopped', 'Backups', '—'],
  ];
  const svcTable = (hi = -1) =>
    `<table class="tbl"><thead><tr><th>Service</th><th>Status</th><th>Group</th><th>Ports</th></tr></thead><tbody>${svcRows.map((r, i) => `<tr${i === hi ? ' class="hi"' : ''}><td>${r[0]}</td><td class="s-${r[1].toLowerCase()}">${r[1]}</td><td>${r[2]}</td><td class="mono">${r[3]}</td></tr>`).join('')}</tbody></table>`;
  add({
    id: 'console',
    group: H,
    title: 'Story: the console, step by step',
    now: 'A large framed console (tabs Services, Files, Health, Modules; EXAMPLE DATA chip) pinned over the sky while seven numbered steps play; a caption under it.',
    weak: 'The frame is big and the step list sits under it as a plain numbered list, so the eye has to go down and back up; nothing on the table shows which step is being talked about; the caption repeats the list.',
    ref: 'Zephium (one persistent window, captions swap under it, a camera over a larger canvas), Supabase and Resend (tab switch with progress).',
    opts: [
      {
        name: 'Pinned window, step rail',
        rec: true,
        cost: 'M M M M',
        why: 'Keep one window pinned, move the seven steps into a slim rail beside it and highlight the part of the table each step talks about. The story and the evidence are in the same place.',
        says: 'This is the whole tour, and you can see where you are.',
        motion:
          'Scroll-linked in the site (autoplay here, 3.2 s a step): the rail marker slides on the emphasised curve (320 ms), the caption crossfades and rises 8 px (280 ms), the matching row lights. Click or arrow keys pick a step. Reduced motion: no autoplay.',
        style: st({ h: '420px' }),
        html: `<div class="cs" data-tabs data-auto="3200">
          <div class="gl pad cs-win"><div class="flex btw"><span class="flex"><i class="tl"></i><i class="tl"></i><i class="tl"></i><b>Services</b></span>${EX}</div>${svcTable(2)}</div>
          <div class="cs-rail"><div role="tablist" aria-label="Steps" class="rail">${steps.map((s, i) => `<button role="tab" type="button" aria-selected="${i === 0}"><span class="n">${i + 1}</span>${s[0]}</button>`).join('')}</div>
          <div class="cs-cap">${steps.map((s, i) => `<p data-panel="${i}" ${i ? 'hidden' : ''} class="p"><b style="color:var(--text)">${s[0]}.</b> ${s[1]}</p>`).join('')}</div><div class="prog"><i></i></div></div>
        </div>`,
      },
      {
        name: 'Tab-switch product shot',
        cost: 'S S S S',
        why: "Four tabs that are the console's own tabs; each shows its screen with a one-line caption. Familiar from developer sites, light, and complete without scroll tricks.",
        says: 'Four things it does, each one real.',
        motion:
          'Autoplay 4 s a tab with a thin amber progress bar, stops for good on the first click or focus. Indicator slides 320 ms emphasised; panels crossfade and rise 8 px in 280 ms. Reduced motion: no autoplay, instant swap.',
        style: st({ h: '420px' }),
        html: `<div data-tabs data-auto="4000" class="col" style="align-items:center">
          <div role="tablist" aria-label="Console tabs" class="tabs"><span class="ind"></span>${['Services', 'Files', 'Health', 'Modules'].map((t, i) => `<button role="tab" type="button" aria-selected="${i === 0}">${t}</button>`).join('')}</div>
          <div class="prog" style="inline-size:220px"><i></i></div>
          <div class="gl pad" style="inline-size:100%;position:relative;min-block-size:250px">
            <div data-panel="0">${svcTable()}<p class="sm mt-s">Every service it finds by asking Docker, with its state, ports and image on one page. ${EX}</p></div>
            <div data-panel="1" hidden><ul>${['README.md', 'runbook.md', 'ports.md'].map((f) => `<li class="row">${ic('file')}<span class="mono gr">${f}</span></li>`).join('')}</ul><p class="sm mt-s">Notes kept on the machine, read as documents. ${EX}</p></div>
            <div data-panel="2" hidden><div class="g3">${['Up', 'Unknown', 'Stopped'].map((t, i) => `<div class="card pad"><p class="big">${[3, 0, 0][i]}</p><p class="sm">${t}</p></div>`).join('')}</div><p class="sm mt-s">One glance at whether the machine is all right. ${EX}</p></div>
            <div data-panel="3" hidden><div class="code"><span class="pr">$ </span>bothy module add &lt;name&gt;</div><p class="sm mt-s">Add a module from the command line, and see its memory. No published release carries a module yet.</p></div>
          </div></div>`,
      },
      {
        name: 'Camera over the canvas',
        cost: 'L M M M',
        why: 'One large console canvas sits behind a fixed frame; for each step the camera glides and zooms to the part being described while the rest dims. Detail stays readable on a phone without a second mock-up.',
        says: 'Look here. Now here.',
        motion:
          'Scroll-linked in the site; here click the steps. The canvas moves with transform only, 700 ms on the emphasised curve; a vignette dims what is out of focus. Reduced motion: whole canvas, no moves.',
        style: st({ h: '420px' }),
        html: `<div data-tabs class="cam">
          <div role="tablist" aria-label="Steps" class="tabs"><span class="ind"></span>${['Services', 'Open one', 'Health', 'Files'].map((t, i) => `<button role="tab" type="button" aria-selected="${i === 0}">${t}</button>`).join('')}</div>
          <div class="cam-frame"><div class="cam-canvas" data-cam="0">
            <div class="card pad cam-a">${svcTable()}</div>
            <div class="card pad cam-b"><b>Wiki</b> <span class="chip">Starting</span><p class="sm mt-s">Image wiki-app:2.2 · port 8090</p><p class="flex mt-s"><span class="pill">Restart</span><span class="pill">Stop</span></p></div>
            <div class="card pad cam-c"><p class="big">3 <span class="sm">up</span></p><p class="sm">0 unknown · 0 stopped</p></div>
            <div class="card pad cam-d">${['README.md', 'runbook.md'].map((f) => `<p class="row">${ic('file')}<span class="mono">${f}</span></p>`).join('')}</div>
          </div><span class="cam-vig" aria-hidden="true"></span></div>
          <p class="sm" style="text-align:center">${EX} The canvas is one picture; the frame is the camera.</p></div>`,
      },
    ],
  });

  // 04 Descent and hut ------------------------------------------------------------
  const code = [
    'Leave it as you found it.',
    'Respect other users and the place.',
    'Keep numbers down.',
    'Turn no one away.',
  ];
  add({
    id: 'descent',
    group: H,
    title: 'Story: the descent and the hut',
    now: 'Chapter 1 "What a bothy is" (a glass card with the Bothy Code) and chapter 2 "One console for one machine" (a glass card on the right) over scene backdrops that cross-fade.',
    weak: 'Without WebGL or before the backdrops load both chapters are a single card on black; the cards are the same shape as every other card, so the story does not feel like it moves down a hill.',
    ref: 'Apple product pages (scroll-scrubbed scenes), Zephium (sky exit), site/public/scene-mock (our own backdrops).',
    opts: [
      {
        name: 'Clouds part',
        rec: true,
        cost: 'M M M S',
        why: 'Three of our own cloud photographs as layers that move at different speeds as you scroll, so you pass through cloud to the hut. The card stays plain and readable on top.',
        says: 'You are coming down out of the sky.',
        motion:
          'Scroll-linked: the far layer moves 8 %, the middle 16 %, the near one 30 % and fades; the card rises 18 px as it enters. Transform and opacity only. Scrub to see it. Reduced motion: one still layer.',
        style: st({ h: '400px' }),
        html: `<div class="layers" aria-hidden="true"><span class="ly a-par" style="--img:var(--twilight);--from:-4%;--to:4%;--t:4s"></span><span class="ly a-par" style="--img:var(--cumulus);--from:6%;--to:-10%;--t:4s;opacity:.55"></span><span class="ly ly-near a-par" style="--img:var(--glowsky);--from:20%;--to:-30%;--t:4s"></span></div>
          <div class="gl pad a-up" style="max-inline-size:440px;--w:1.2s"><p class="h3">What a bothy is</p><p class="p mt-s">In the hills of Scotland, and of northern England and Wales, a bothy is a basic shelter: four walls and a roof, no charge and nobody at the door. Volunteers keep them up.</p></div>`,
      },
      {
        name: 'The window lights',
        cost: 'M S S S',
        why: 'A simple hut on a dark hill; as the chapter arrives its window turns on, amber, and the words "One console for one machine" come up beside it. A small, memorable beat that needs no photograph.',
        says: 'Here is the shelter. It is open.',
        motion:
          'On entering view: hill and hut fade in (600 ms), the window goes from dark to amber in 400 ms after 0.6 s, its glow breathes once; text rises 18 px, 80 ms apart. Reduced motion: lit from the start.',
        style: st({ h: '400px' }),
        html: `<div class="split"><svg class="hut a-fade" viewBox="0 0 400 240" aria-hidden="true"><path d="M0 200 Q120 120 220 170 T400 150 V240 H0Z" fill="#14161f"/><path d="M150 150 L200 112 L250 150 V196 H150Z" fill="#1d2030"/><path d="M140 152 L200 104 L260 152" stroke="#2a2e40" stroke-width="8" fill="none"/><rect class="win-lit a-fade" style="--w:.6s;--t:.4s" x="188" y="150" width="24" height="22" rx="2" fill="#ffd58a"/><circle class="lp-pulse" cx="200" cy="161" r="16" fill="rgb(255 213 138 / 35%)" style="transform-box:fill-box;transform-origin:center"/></svg>
          <div class="col"><p class="h2 a-up" style="--d:1">One console for one machine</p><p class="p a-up" style="--d:2">Bothy is a web console for a single machine. It finds what is running by asking Docker, shows it on one page, and gives you a reader for the files and notes kept on that machine.</p><span class="pill a-up" style="--d:3;justify-self:start;inline-size:max-content">Read the guide</span></div></div>`,
      },
      {
        name: 'The Bothy Code, dealt',
        cost: 'S S S S',
        why: 'The four rules of the Bothy Code are the soul of the name; give each its own card, dealt onto the table one after another, instead of four rows in a box.',
        says: 'These are the manners the software keeps.',
        motion:
          'On entering view: cards fall into place from 24 px above with a 4 degree turn that settles to 0, 500 ms emphasised, 120 ms apart. Reduced motion: laid out still.',
        style: st({ h: '400px' }),
        html: `<p class="eb">The Bothy Code, in short</p><p class="h2 mt-s">What a bothy is</p>
          <ol class="g4 mt">${code.map((c, i) => `<li class="card pad deal a-up" style="--d:${i};--st:.12s;--y:-24px;--r:${(i % 2 ? 1 : -1) * 2}deg"><span class="sm">${i + 1}</span><p class="h3 mt-s">${c}</p></li>`).join('')}</ol>
          <p class="sm mt">From the Mountain Bothies Association’s Bothy Code, shortened.</p>`,
      },
    ],
  });

  // 05 What is inside ---------------------------------------------------------------
  const inside = [
    ['grid', 'Overview', 'The machine at a glance: what is up, unknown and stopped, then a card for each system.'],
    ['file', 'Files', 'Every document on the machine, read straight from the disk it lives on.'],
    ['users', 'Roles', 'Four roles. Holding one never implies another.'],
    ['palette', 'Themes', 'Five themes ship with it. A theme you add is one CSS file.'],
  ];
  const stats = [
    ['38', ' MiB', 'memory used by Bivvy’s three containers, in our lab'],
    ['960', ' MiB', 'free memory the installer wants before it starts'],
    ['4', '', 'roles: viewer, editor, operator and shell'],
    ['5', '', 'themes ship with it'],
  ];
  add({
    id: 'inside',
    group: H,
    title: 'What is inside',
    now: 'Heading, lede, then four equal glass cards in a three-column grid (Overview, Files, Roles, Themes), so the fourth sits alone on a second row; a small note under them.',
    weak: 'Three columns for four items leaves a hole; every card is text only, so nothing shows; the cards float (bob) which reads as decoration, not information.',
    ref: 'Owner reference 4 (two-column header, three dark cards with a white icon, a stats row with hairline tops); Linear and Vercel (spotlight cards); bento grids.',
    opts: [
      {
        name: 'Header, cards and a stats row',
        rec: true,
        cost: 'S S S S',
        why: "The owner's reference layout, made true: a two-column header, four equal dark cards with a white icon, then a row of real measured numbers under hairlines. The numbers are the strongest thing we can say.",
        says: 'Small, and we measured it.',
        motion:
          'On entering view: cards rise 18 px, 70 ms apart (700 ms emphasised); hairlines draw from the start edge (600 ms); numbers count up from 0 in 1.2 s ease-out with tabular figures so nothing shifts. Reduced motion: final numbers.',
        style: st({ h: '470px' }),
        html: `<div class="split" style="align-items:end"><p class="h2 a-up">What is inside</p><p class="p a-up" style="--d:1">These are the parts the guide documents today. Each card links to the page that describes it.</p></div>
          <ul class="g4 mt">${inside.map((c, i) => `<li class="card pad a-up" style="--d:${i + 1};--st:.07s">${ic(c[0], 'ico-w')}<p class="h3 mt-s">${c[1]}</p><p class="sm mt-s">${c[2]}</p></li>`).join('')}</ul>
          <ul class="g4 mt">${stats.map((s, i) => `<li class="hl2"><span class="hlr a-sx" style="--d:${i};--t:.6s"></span><p class="big"><span class="cnt a-cnt" style="--to:${s[0]};--t:1.2s;--e:ease-out;--w:.3s"></span><span class="unit">${s[1]}</span></p><p class="sm">${s[2]}</p></li>`).join('')}</ul>`,
      },
      {
        name: 'Bento with live tiles',
        cost: 'M M S S',
        why: 'One large Overview tile and three smaller ones, each holding a tiny working piece of the console: a status line, a file list, the four roles, five theme swatches. Shows, not tells.',
        says: 'Each part is real and does one thing.',
        motion:
          'On entering view: tiles pop from 96 %, 80 ms apart; inside, role chips light one after another (150 ms apart) and the swatches pop in a row. Reduced motion: still.',
        style: st({ h: '470px' }),
        html: `<p class="h2">What is inside</p>
          <div class="bento mt">
            <div class="card pad b1 a-pop" style="--s:.96"><p class="eb">Overview</p><p class="big mt-s">3 <span class="unit">up</span></p><p class="sm">0 unknown · 0 stopped</p><ul class="mt-s">${services.map(([n, s]) => `<li class="row"><span class="dot"></span><span class="mono">${n}</span><span class="sm gr">${s}</span></li>`).join('')}</ul><p class="sm mt-s">${EX}</p></div>
            <div class="card pad b2 a-pop" style="--s:.96;--d:1"><p class="eb">Files</p><ul class="mt-s">${['README.md', 'runbook.md', 'ports.md'].map((f) => `<li class="row">${svg('file', 'class="i16"')}<span class="mono sm">${f}</span></li>`).join('')}</ul><p class="sm">The reader never writes.</p></div>
            <div class="card pad b3 a-pop" style="--s:.96;--d:2"><p class="eb">Roles</p><p class="flex wrap mt-s">${['viewer', 'editor', 'operator', 'shell'].map((r, i) => `<span class="chip a-pop" style="--w:.4s;--d:${i};--st:.15s">${r}</span>`).join('')}</p><p class="sm mt-s"><span class="mono">shell</span> is defined and granted to nobody.</p></div>
            <div class="card pad b4 a-pop" style="--s:.96;--d:3"><p class="eb">Themes</p><p class="flex mt-s">${['#f4efe6', '#8fe3bf', '#ffd58a', '#8ea6ff', '#1d2030'].map((c, i) => `<span class="sw a-pop" style="background:${c};--w:.5s;--d:${i};--st:.08s"></span>`).join('')}</p><p class="sm mt-s">Five ship with it. ${EX} colours.</p></div>
          </div>`,
      },
      {
        name: 'Spotlight cards',
        cost: 'S S S M',
        why: 'Keep four plain cards in one row and give them a soft amber light that follows the pointer across all four, lighting their edges. Keyboard focus lights the focused card the same way.',
        says: 'Polished, and quietly alive.',
        motion:
          'Pointer: a 260 px radial light and a 1 px edge light track the pointer (CSS variables, no animation loop); they fade in over 300 ms on hover. Reveal: rise 18 px, 70 ms apart. Touch: no light. Reduced motion: no reveal, light kept (it is not motion).',
        style: st({ h: '330px' }),
        html: `<p class="h2">What is inside</p><p class="p mt-s">Point at the cards, or tab through them.</p>
          <ul class="g4 mt" data-spot>${inside.map((c, i) => `<li class="card pad spot a-up" style="--d:${i};--st:.07s"><a href="#inside" class="cover">${ic(c[0])}<span class="h3 mt-s" style="display:block">${c[1]}</span><span class="sm mt-s" style="display:block">${c[2]}</span></a></li>`).join('')}</ul>`,
      },
    ],
  });

  // 06 Four sizes --------------------------------------------------------------------------
  const modes = [
    [
      'Bivvy',
      'a roof, a door, a lock',
      'The console, a read-only file reader and the edge that serves them. Runs on Docker Compose.',
      'About 38 MiB of memory across its three containers, in our lab. The installer wants 960 MiB free.',
      true,
    ],
    ['Bothy', 'four walls and a fire', 'Bivvy plus metrics, logs, alerts and backups.', 'Not yet measured.'],
    [
      'Basecamp',
      'everything before the climb',
      'Bothy plus dashboards, single sign-on, a database and a cluster view.',
      'Not yet measured.',
    ],
    ['Cairn', 'stack your own stones', 'Pick modules one at a time.', 'Not yet measured.'],
  ];
  const chip = (now) =>
    now ? '<span class="chip ok">✓ Installable now</span>' : '<span class="chip pl">○ Planned, not built</span>';
  add({
    id: 'sizes',
    group: H,
    title: 'Four sizes (modes)',
    now: 'Four equal glass cards in a row: a state chip ("Installable now" or "Planned, not built"), the name, an italic tagline, the contents and the cost; Cairn carries a long note.',
    weak: 'Four equal cards say four equal products, when only one exists; the green chip is the only difference; the Cairn note makes that card twice as tall; the names (shelters on a hill) are not used visually.',
    ref: 'Apple comparison tables, Resend and Vercel tier cards (one highlighted), segmented pickers.',
    opts: [
      {
        name: 'Up the hill',
        rec: true,
        cost: 'M S S S',
        why: 'Draw the four sizes as places on one hill, smallest at the bottom: Bivvy lit and solid, the others outlined and dashed further up. Then the one that exists gets the detail, and the others one line each.',
        says: 'Start small; the rest is a path, not a promise.',
        motion:
          "On entering view: the path draws up the hill (scale from the start, 900 ms), markers pop in order 150 ms apart, Bivvy's ring pulses twice. Reduced motion: drawn complete.",
        style: st({ h: '440px' }),
        html: `<p class="h2">Four sizes</p><p class="p mt-s">Named for the shelters walkers use, smallest first. Only the smallest installs today.</p>
          <div class="hill mt"><svg viewBox="0 0 800 170" aria-hidden="true" preserveAspectRatio="none"><path d="M0 170 C200 150 300 120 420 90 S640 30 800 18 V170Z" fill="#11131b"/><path class="a-sx" style="--t:.9s" d="M40 160 C200 140 300 118 420 88 S640 34 780 22" stroke="rgb(255 255 255 / 25%)" stroke-dasharray="4 6" fill="none" stroke-width="2"/></svg>
            ${modes.map((m, i) => `<div class="mk a-pop" style="--d:${i};--st:.15s;--w:.5s;inset-inline-start:${[4, 30, 52, 76][i]}%;inset-block-end:${[8, 34, 58, 80][i]}%"><span class="pin ${m[4] ? 'on' : ''}">${m[4] ? '<i class="lp-pulse"></i>' : ''}</span><b>${m[0]}</b><span class="sm">${m[4] ? 'Installable now' : 'Planned'}</span></div>`).join('')}</div>
          <div class="g2 mt"><div class="card pad" style="border-color:rgb(143 227 191 / 35%)">${chip(true)}<p class="h3 mt-s">Bivvy <span class="sm serif">· a roof, a door, a lock</span></p><p class="sm mt-s">${modes[0][2]} ${modes[0][3]}</p></div>
          <ul class="col">${modes
            .slice(1)
            .map(
              (m) =>
                `<li class="row"><b>${m[0]}</b><span class="sm gr">${m[2]}</span><span class="chip pl">Planned</span></li>`,
            )
            .join('')}</ul></div>`,
      },
      {
        name: 'Comparison table, one lit column',
        cost: 'S S S S',
        why: "A plain comparison table: four columns, the same rows for each. Bivvy's column is lit and solid; the planned ones are dimmed with dashed edges. Honest, scannable and printable.",
        says: 'Here is exactly what each size holds, and what exists.',
        motion:
          "On entering view: columns rise 12 px, 90 ms apart; the lit column's edge draws top to bottom (500 ms). Hovering a column brightens it (150 ms). Reduced motion: still.",
        style: st({ h: '420px' }),
        html: `<p class="h2">Four sizes</p>
          <div class="cmp mt" role="table" aria-label="Sizes compared">
            <div role="row" class="cmp-r"><span role="rowheader"></span>${modes.map((m, i) => `<span role="columnheader" class="cmp-h a-up ${m[4] ? 'lit' : ''}" style="--d:${i};--st:.09s"><b>${m[0]}</b><span class="sm serif">${m[1]}</span></span>`).join('')}</div>
            <div role="row" class="cmp-r"><span role="rowheader" class="sm">State</span>${modes.map((m, i) => `<span role="cell" class="a-up ${m[4] ? 'lit' : ''}" style="--d:${i};--st:.09s">${chip(m[4])}</span>`).join('')}</div>
            <div role="row" class="cmp-r"><span role="rowheader" class="sm">Holds</span>${modes.map((m, i) => `<span role="cell" class="sm a-up ${m[4] ? 'lit' : ''}" style="--d:${i};--st:.09s">${m[2]}</span>`).join('')}</div>
            <div role="row" class="cmp-r"><span role="rowheader" class="sm">Cost</span>${modes.map((m, i) => `<span role="cell" class="sm a-up ${m[4] ? 'lit' : ''}" style="--d:${i};--st:.09s">${m[4] ? '38 MiB used · 960 MiB gate' : 'Not yet measured'}</span>`).join('')}</div>
          </div>`,
      },
      {
        name: 'Size picker',
        cost: 'S S S S',
        why: 'A segmented control with the four names; one size shown at a time in a single roomy card. The planned sizes say so plainly when picked. Short on the page, and it invites a click.',
        says: 'Pick the size that fits; only one is ready.',
        motion:
          'Click or arrow keys: the pill slides 320 ms emphasised; the card content crossfades and rises 8 px in 280 ms. Planned sizes swap the solid edge for a dashed one. Reduced motion: instant.',
        style: st({ h: '380px' }),
        html: `<div data-tabs class="col" style="align-items:center"><p class="h2">Four sizes</p>
          <div role="tablist" aria-label="Sizes" class="tabs"><span class="ind"></span>${modes.map((m, i) => `<button role="tab" type="button" aria-selected="${i === 0}">${m[0]}</button>`).join('')}</div>
          <div class="card pad" style="inline-size:min(560px,100%);position:relative;min-block-size:180px">${modes.map((m, i) => `<div data-panel="${i}" ${i ? 'hidden' : ''}>${chip(m[4])}<p class="h3 mt-s">${m[0]} <span class="sm serif">· ${m[1]}</span></p><p class="p mt-s">${m[2]}</p><p class="sm mt-s"><b>Cost.</b> ${m[3]}</p></div>`).join('')}</div></div>`,
      },
    ],
  });

  // 07 Install chapter ---------------------------------------------------------------------
  const cmds = [
    ['Download the archive and the checksums', 'curl -fsSLO …/bothy_2026.11.2_linux_amd64.tar.gz'],
    ['Put it on your path', 'tar -xzf bothy_2026.11.2_linux_amd64.tar.gz && install -D bothy ~/.local/bin/bothy'],
    ['Read the plan', 'bothy install --dry-run'],
    ['Install', 'bothy install'],
  ];
  const checks = [
    'Docker is present and answering, with Compose v2.',
    'Free memory against the gate: 960 MiB.',
    'The port (80 unless you pass --port) is free.',
    'The release is found, from the binary’s own version.',
    'The sha256 checks pass.',
    'The build attestation, when gh is present.',
  ];
  add({
    id: 'install-ch',
    group: H,
    title: 'Install with one command',
    now: 'Heading, a terminal with the four commands, a sudo note, then two columns of text ("What it checks", "What it did", "Leaving"), a green-bordered lab note, and the two long "shown / not shown" lists.',
    weak: "It is the longest section on the page and almost all text; the terminal's first line runs off the edge; the proof lists repeat the Install page word for word; nothing guides the eye from step 1 to step 4.",
    ref: 'Warp (typed terminal), Zed and Ghostty (one command with copy), stepper rails on docs sites.',
    opts: [
      {
        name: 'Numbered rail',
        rec: true,
        cost: 'M S S S',
        why: 'Four numbered steps down a rail that fills as you scroll; each step has one short sentence and its command with a copy button. The proof lists move to the Install page and are linked.',
        says: 'Four steps, in order, and you always know which one you are on.',
        motion:
          'Scroll-linked: the rail fills from the top (transform scaleY), the step in the middle of the view brightens and its number fills amber (150 ms). Scroll inside the box to try it. Reduced motion: full rail, all steps bright.',
        style: st({ h: '420px' }),
        html: `<p class="h2">Install with one command</p>
          <div class="rail-sc mt" data-scroll="rail" tabindex="0" aria-label="Install steps, scrollable"><span class="rail-line" aria-hidden="true"><i></i></span>
            ${cmds.map((c, i) => `<div class="rstep" data-step><span class="rn">${i + 1}</span><div class="gr"><p class="h3">${c[0]}</p><div class="code flex btw mt-s"><span class="ell"><span class="pr">$ </span>${c[1]}</span><button type="button" class="pill" data-copy="${c[1]}">Copy</button></div></div></div>`).join('')}
            <p class="sm" style="padding:12px 0 140px 48px">Run it as your own user, without sudo. Run with sudo it refuses and changes nothing.</p></div>`,
      },
      {
        name: 'One terminal, typed',
        cost: 'S S S M',
        why: 'The four commands typed out one after another in a single terminal, each answered by a short line of output, so the whole install reads like watching someone do it once.',
        says: 'This is all there is to it.',
        motion:
          'On entering view, once: each command types at 45 ms a character, its output appears 300 ms later, the next starts 400 ms after. Copy copies all four. Screen readers get the plain text (the cover is decoration). Reduced motion: all shown.',
        style: st({ h: '420px' }),
        html: `<div class="split" style="align-items:start"><div><p class="h2">Install with one command</p><p class="p mt-s">Once you have the <span class="kbd">bothy</span> file, <span class="kbd">bothy install</span> is the whole job.</p></div>
          <div class="code term"><div class="flex btw"><span class="flex"><i class="tl"></i><i class="tl"></i><i class="tl"></i></span><button type="button" class="pill" data-copy="${cmds.map((c) => c[1]).join('\n')}">Copy</button></div>
          ${cmds.map((c, i) => `<p><span class="pr">$ </span><span class="tw" style="--n:${Math.min(c[1].length, 40)};--w:${(i * 2.4).toFixed(1)}s">${c[1].length > 46 ? c[1].slice(0, 44) + '…' : c[1]}</span></p><p class="out a-fade" style="--w:${(i * 2.4 + 2).toFixed(1)}s;--t:.3s">${['saved bothy_2026.11.2_linux_amd64.tar.gz', 'bothy 2026.11.2', 'plan printed, nothing changed', 'Bivvy is up at the printed address'][i]} <span class="ex">EXAMPLE</span></p>`).join('')}</div></div>`,
      },
      {
        name: 'Checks, then what it did',
        cost: 'S S S S',
        why: 'Make the two lists the visual: on the left the six checks tick one after another, a divider draws, then on the right the three things it did slide in. The order is the point: check first, change after.',
        says: 'It looks before it leaps.',
        motion:
          'On entering view: ticks pop 250 ms apart (scale 0.6 to 1, 300 ms); the divider draws down (500 ms) after the last; the right column slides in from 28 px, 120 ms apart. Reduced motion: all shown.',
        style: st({ h: '420px' }),
        html: `<p class="h2">Install with one command</p><div class="code mt"><span class="pr">$ </span>bothy install</div>
          <div class="g2 mt chk2"><div><p class="eb">What it checks first</p><ul class="mt-s">${checks.map((c, i) => `<li class="row"><span class="tk a-pop" style="--s:.6;--t:.3s;--d:${i};--st:.25s">✓</span><span class="sm" style="color:var(--text)">${c}</span></li>`).join('')}</ul></div>
          <div class="vline a-sy" style="--w:1.6s;--t:.5s" aria-hidden="true"></div>
          <div><p class="eb">Then what it did</p><ul class="mt-s">${['Pulled three images by digest.', 'Started them, then read the bytes the edge actually serves.', 'Printed the address. Open it in a browser.'].map((t, i) => `<li class="row a-rt" style="--w:2s;--d:${i};--st:.12s"><span class="dot"></span><span class="sm" style="color:var(--text)">${t}</span></li>`).join('')}</ul></div></div>`,
      },
    ],
  });

  // 08 Trust ----------------------------------------------------------------------------------
  const tlinks = [
    ['code', 'Source', 'All of it, in one repository.'],
    ['book', 'Licence', 'MIT.'],
    ['tag', 'Releases', 'Binaries, checksums and attestations.'],
    ['lock', 'Security policy', 'What is protected, and how to report a problem.'],
  ];
  const claims = [
    'Releases carry sha256 checksums and a build attestation.',
    'The installer verifies before it changes anything, and rolls back when something fails.',
    '<span class="kbd">bothy uninstall</span> removes what the install added.',
    'This site runs no analytics, sets no cookie and loads nothing from another site.',
  ];
  const stars = (n) =>
    Array.from(
      { length: n },
      (_, i) =>
        `<i class="star-d lp-tw" style="--d:${i};inset-inline-start:${(i * 37) % 100}%;inset-block-start:${(i * 53) % 70}%;--t:${2.4 + (i % 4) * 0.7}s"></i>`,
    ).join('');
  add({
    id: 'trust',
    group: H,
    title: 'Leave it as you found it (trust)',
    now: 'Heading, "Each line here can be checked.", four bullet claims, four bordered link boxes (Source, Licence, Releases, Security policy), a hairline, the amber serif closing line and the sky footnote.',
    weak: 'Bullets and boxes on a dark band: the most important promise on the site looks like fine print; link boxes have uneven heights and purple underlines that fight the palette.',
    ref: 'Owner reference 3 ("Built in the open": night cloud photograph, heading left, link rows with icon and arrow on the right, a wide glass band below).',
    opts: [
      {
        name: 'Built in the open',
        rec: true,
        cost: 'S S S S',
        why: "The owner's reference layout over our night sky: heading and claims on the left, four hairline link rows with an icon and an arrow on the right, and a wide glass band holding the dry-run command. No stars or contributor counts: we do not show numbers we have not got.",
        says: 'Everything here can be checked, and here is where.',
        motion:
          'On entering view: heading rises, claims fade 80 ms apart, link rows slide in from 28 px, 90 ms apart; the band rises last. Arrow nudges 4 px on hover or focus (220 ms). Reduced motion: still.',
        cls: 'sky',
        style: st({ img: 'var(--night)', h: '470px' }),
        html: `<div class="split" style="align-items:start"><div><p class="h2 a-up">Leave it as you found it</p><p class="p a-up mt-s" style="--d:1">Each line here can be checked.</p><ul class="mt-s">${claims.map((c, i) => `<li class="row a-fade" style="--d:${i + 2}"><span class="tk">✓</span><span class="sm" style="color:var(--text)">${c}</span></li>`).join('')}</ul></div>
          <nav aria-label="Where to check">${tlinks.map((l, i) => `<a class="lk a-rt" href="#trust" style="--d:${i + 2};--st:.09s">${ic(l[0])}<span><b>${l[1]}</b><br><span class="sm">${l[2]}</span></span><span class="ar">→</span></a>`).join('')}</nav></div>
          <div class="gl band flex btw mt a-up" style="--w:.7s"><span class="p">Read the plan before anything changes.</span><span class="flex"><span class="code" style="padding:8px 12px">bothy install --dry-run</span><button type="button" class="pill lit" data-copy="bothy install --dry-run">Copy</button></span></div>`,
      },
      {
        name: 'Receipts',
        cost: 'S M S S',
        why: 'Each claim set as a receipt line with the place to check it, and a small "checkable" stamp that lands on each in turn. Playful, but it makes the point that these are verifiable, not adjectives.',
        says: 'We kept the receipts.',
        motion:
          'On entering view: rows rise 70 ms apart, then each stamp drops from 180 % to 100 % with a 6 degree turn (500 ms, slight overshoot), 200 ms apart. Reduced motion: stamps in place.',
        style: st({ h: '440px' }),
        html: `<p class="h2">Leave it as you found it</p><p class="p mt-s">Each line here can be checked.</p>
          <ul class="mt rcpt">${claims.map((c, i) => `<li class="row a-up" style="--d:${i}"><span class="mono sm">0${i + 1}</span><span class="gr" style="color:var(--text)">${c}</span><a class="sm" href="#trust">${['Releases', 'Install notes', 'Source', 'About'][i]} →</a><span class="stamp a-stamp" style="--w:.6s;--d:${i};--st:.2s;--t:.5s">checkable</span></li>`).join('')}</ul>
          <p class="serif amber h3 mt">Leave it as you found it. Turn no one away.</p>`,
      },
      {
        name: 'The night returns',
        cost: 'M S M S',
        why: 'The story ends at night: the photograph zooms out slowly, a few stars come out, and the claims appear one by one, closing on the amber line in the serif. A real ending to the scroll before the dark sections.',
        says: 'Rest here. Nothing is hidden.',
        motion:
          'On entering view: the night photo settles from 112 % (1.6 s); stars twinkle on long loops (2.4 to 4.5 s, opacity only, stop when off screen); claims fade 150 ms apart; the closing line last. Reduced motion: still night, no twinkle.',
        cls: 'sky',
        style: st({ img: 'none', h: '440px' }),
        html: `<span class="nightbg a-zoom" style="--t:1.6s" aria-hidden="true"></span><span class="stars" aria-hidden="true">${stars(26)}</span>
          <div class="col" style="max-inline-size:620px"><p class="h2 a-up">Leave it as you found it</p>${claims.map((c, i) => `<p class="p a-fade" style="--w:.4s;--d:${i};--st:.15s">${c}</p>`).join('')}<p class="serif amber h3 a-up" style="--w:1.2s">Leave it as you found it. Turn no one away.</p></div>`,
      },
    ],
  });

  // 09 After-story intro ------------------------------------------------------------------------------
  add({
    id: 'after-intro',
    group: H,
    title: 'After the story: "What you get" heading',
    now: 'Eyebrow "What you get" with an amber dot, the heading "A small console, kept honest." and a muted lede, left aligned on black.',
    weak: 'It is the first thing on black after the sky and it arrives with no ceremony; heading and lede stack in one narrow column leaving the right half empty.',
    ref: 'Owner reference 4 (giant heading left, muted paragraph right), owner reference 2 (two-tone heading).',
    opts: [
      {
        name: 'Two-column header',
        rec: true,
        cost: 'S S S S',
        why: "Giant heading on the left, the muted lede on the right aligned to its last line, the owner's reference layout. It uses the full width and becomes the pattern for every section head that follows.",
        says: 'A new part of the page starts here.',
        motion:
          'On entering view: each heading line slides up out of a mask (800 ms emphasised, 90 ms apart); the lede fades in after 300 ms. Reduced motion: still.',
        style: st({ h: '260px' }),
        html: `<p class="eb">What you get</p><div class="split mt-s" style="align-items:end"><p class="d" style="font-size:clamp(28px,6cqi,76px)"><span class="mask"><span class="a-line" style="--t:.8s">A small console,</span></span><span class="mask"><span class="a-line" style="--d:1;--st:.09s;--t:.8s">kept honest.</span></span></p><p class="p a-fade" style="--w:.3s">This is what Bivvy, the size that installs today, gives you. The panels inside the pictures are examples, not your machine.</p></div>`,
      },
      {
        name: 'Two-tone heading',
        cost: 'S S S S',
        why: "The heading's second line in grey, as in the owner's closing-band reference, so it reads as a statement and its quiet answer. Centred, with the eyebrow's amber dot pulsing once as you arrive.",
        says: 'Small, and honest about it.',
        motion:
          'On entering view: the dot pulses once (ring 0.6 to 2.4, 2.4 s); line one rises, line two rises 120 ms later and settles at 46 % white. Reduced motion: still.',
        style: st({ h: '260px' }),
        html: `<div class="col ctr" style="align-items:center"><p class="eb pulse-eb"><i class="lp-pulse"></i>What you get</p><p class="d" style="font-size:clamp(28px,6.4cqi,80px)"><span class="a-up" style="display:block">A small console,</span><span class="a-up grey" style="display:block;--d:1;--st:.12s">kept honest.</span></p><p class="p a-fade" style="--w:.4s;max-inline-size:52ch">This is what Bivvy, the size that installs today, gives you.</p></div>`,
      },
      {
        name: 'Horizon line',
        cost: 'S S S S',
        why: 'A thin strip of dusk sky with a hairline horizon drawing across it marks the hand-over from the story to the dark sections; the heading sits under it. A seam that remembers the sky.',
        says: 'You have come down from the sky; now the details.',
        motion:
          'On entering view: the horizon draws from the start edge (900 ms emphasised) while a small amber light travels along it; the heading rises after 300 ms. Reduced motion: drawn.',
        style: st({ h: '280px' }),
        html: `<div class="strip" aria-hidden="true"><span class="hz a-sx" style="--t:.9s"></span><span class="hz-dot a-rt" style="--t:.9s"></span></div><p class="eb mt">What you get</p><p class="h2 a-up mt-s" style="--w:.3s">A small console, kept honest.</p><p class="p a-fade" style="--w:.5s;max-inline-size:60ch">This is what Bivvy, the size that installs today, gives you. The panels inside the pictures are examples, not your machine.</p>`,
      },
    ],
  });

  // 10 Two-up photo cards ------------------------------------------------------------------------------
  const ovPanel = (c = '') =>
    `<div class="gl pad-s mini ${c}"><p class="flex btw"><b>Overview</b>${EX}</p><ul class="mt-s">${services.map(([n, s], i) => `<li class="row a-up" style="--w:.5s;--d:${i};--st:.08s"><span class="dot"></span><span class="gr"><span class="mono">${n}</span> <span class="sm">${s}</span></span><span class="sm">up</span></li>`).join('')}</ul></div>`;
  const fiPanel = (c = '') =>
    `<div class="gl pad-s mini ${c}"><p class="flex btw"><b>Files</b>${EX}</p><ul class="mt-s">${['README.md', 'runbook.md', 'ports.md'].map((f, i) => `<li class="row a-up" style="--w:.5s;--d:${i};--st:.08s">${svg('file', 'class="i16"')}<span class="mono sm gr">${f}</span></li>`).join('')}<li class="row"><span class="gr sm" style="color:var(--text)">Writing</span><span class="sw-t" aria-hidden="true"></span></li></ul></div>`;
  const cap = (b, r) => `<p class="cap"><b>${b}</b> <span>${r}</span></p>`;
  add({
    id: 'two-up',
    group: H,
    title: 'Two photo cards: console and files',
    now: 'Two dark cards side by side; title, bold lead and link at the top, then a sky photograph with a floating glass panel of EXAMPLE rows.',
    weak: 'The text sits above the picture, so the cards start with words and the pictures are pushed down; the two cards differ in height because the leads wrap differently; the panels appear all at once.',
    ref: 'Owner reference 1 (Zephium: heading and two-line lede, two cards each with a framed sky window holding a floating glass panel, caption under the window with a bold lead and a muted rest, a third wide card under them).',
    opts: [
      {
        name: 'Window first, caption under',
        rec: true,
        cost: 'S S S S',
        why: "The owner's reference, made ours: the sky window opens each card and the caption sits under it as one sentence with a bold lead. The pictures lead, the cards line up, and the third wide card starts under them.",
        says: 'Look first, then read one line.',
        motion:
          'On entering view: cards rise 18 px (700 ms emphasised, 100 ms apart); the glass panel floats up 16 px 200 ms later; its rows follow 80 ms apart. Reduced motion: still.',
        style: st({ h: '520px' }),
        html: `<p class="h2">A small console, kept honest.</p><p class="p mt-s" style="max-inline-size:52ch">This is what Bivvy, the size that installs today, gives you.</p>
          <div class="g2 mt"><article class="card pad a-up"><div class="win" style="--img:var(--cumulus);block-size:220px">${ovPanel('a-up" style="--w:.2s;--y:16px')}</div>${cap('See what is running.', 'Bothy asks Docker what is up and shows it on one page, with nothing to register by hand.')}</article>
          <article class="card pad a-up" style="--d:1;--st:.1s"><div class="win" style="--img:var(--twilight);block-size:220px">${fiPanel('a-up" style="--w:.3s;--y:16px')}</div>${cap('Read what is on the disk.', 'A reader for the documents kept on the machine, straight from where they are. It never writes.')}</article></div>
          <div class="card wide-peek mt" aria-hidden="true"></div>`,
      },
      {
        name: 'Parallax windows, leaning panels',
        cost: 'M S M M',
        why: "Same cards, but each photograph moves slower than the card as you scroll, so the window has depth, and the glass panel leans gently toward the pointer. A little of the hero's life carried into the cards.",
        says: 'The sky is still there, behind everything.',
        motion:
          'Scroll-linked: the photo moves from -8 % to 8 % inside its frame (transform, scaled 118 %). Pointer: the panel tilts up to 4 degrees (400 ms ease-out back to flat). Scrub to see the parallax. Reduced motion and touch: no tilt, no parallax.',
        style: st({ h: '440px' }),
        html: `<div class="g2"><article class="card pad"><div class="win pwin" style="block-size:250px"><span class="pimg a-par" style="--img:var(--cumulus);--t:3s"></span><div data-tilt class="tilt">${ovPanel()}</div></div>${cap('See what is running.', 'Bothy asks Docker what is up and shows it on one page.')}</article>
          <article class="card pad"><div class="win pwin" style="block-size:250px"><span class="pimg a-par" style="--img:var(--twilight);--t:3s;--from:8%;--to:-8%"></span><div data-tilt class="tilt">${fiPanel()}</div></div>${cap('Read what is on the disk.', 'A reader for the documents kept on the machine. It never writes.')}</article></div>`,
      },
      {
        name: 'Sticky stacking cards',
        cost: 'M M S M',
        why: 'The console card, the files card and the dry-run card as a stack: each sticks near the top while the next slides over it, and the one behind shrinks and dims. Three ideas, one place on screen.',
        says: 'One thing at a time, in order.',
        motion:
          'Scroll-linked (scroll inside the box): cards are position: sticky; as the next one covers it, a card scales 1 to 0.94 and dims to 65 % brightness. In the site, CSS animation-timeline: view() with a plain stack as the fallback. Reduced motion: a plain stack.',
        style: st({ h: '440px' }),
        html: `<div class="stack-sc" data-scroll="stack" tabindex="0" aria-label="Stacked cards, scrollable">${[
          [
            'var(--cumulus)',
            'See what is running.',
            'Bothy asks Docker what is up and shows it on one page.',
            ovPanel(),
          ],
          [
            'var(--twilight)',
            'Read what is on the disk.',
            'A reader for the documents kept on the machine. It never writes.',
            fiPanel(),
          ],
          [
            'var(--deck)',
            'Read the plan first.',
            'bothy install --dry-run prints the plan and every preflight result, and changes nothing.',
            '',
          ],
        ]
          .map(
            (c, i) =>
              `<article class="card pad stk" data-card style="--i:${i}"><div class="g2"><div class="col">${cap(c[1], c[2])}</div><div class="win" style="--img:${c[0]};block-size:200px">${c[3]}</div></div></article>`,
          )
          .join('')}<div style="block-size:240px"></div></div>`,
      },
    ],
  });

  // 11 Wide dry-run card ---------------------------------------------------------------------------------
  const dry = [
    'Docker answers, Compose v2 present',
    'At least 960 MiB of memory free',
    'Port 80 is free',
    'sha256 matches checksums.txt',
  ];
  add({
    id: 'dry-run',
    group: H,
    title: 'Wide card: it checks before it changes anything',
    now: 'A wide dark card: a very large heading, a bold lead with the dry-run command inline and a link on the left; a sky photograph with a "Dry run" glass panel of four ticked rows on the right.',
    weak: 'The heading is set larger than the section heading above it, so the hierarchy inverts; the ticks are already ticked, so the one thing this card is about, the order of checks, is not shown.',
    ref: 'Warp (typed terminal), Magic UI animated beam, Vercel wide feature cards.',
    opts: [
      {
        name: 'Checks tick in order',
        rec: true,
        cost: 'S S S S',
        why: 'Keep the layout, bring the heading down to card size, and let the four checks tick one after another, then the footer line "The checks are real; the ticks are an example." The order of the ticks is the message.',
        says: 'It checks, in order, before it touches anything.',
        motion:
          'On entering view: rows appear dim; each tick pops (scale 0.6 to 1, 300 ms) 350 ms apart and its row brightens; the footer fades last. Reduced motion: all ticked.',
        style: st({ h: '360px' }),
        html: `<div class="card pad split"><div class="col"><p class="h2" style="font-size:clamp(22px,3.4cqi,40px)">It checks before it changes anything</p><p class="p"><b style="color:var(--text)">Read the plan first.</b> <span class="kbd">bothy install --dry-run</span> prints the plan and every preflight result, and changes nothing. If one fails, it stops with the fix named.</p><a class="sm" href="#dry-run">What the install checks →</a></div>
          <div class="win" style="--img:var(--deck);block-size:260px"><div class="gl pad-s mini"><p class="flex btw"><b>Dry run</b>${EX}</p><ul class="mt-s">${dry.map((d, i) => `<li class="row"><span class="tk a-pop" style="--s:.6;--t:.3s;--w:.3s;--d:${i};--st:.35s">✓</span><span class="sm a-fade" style="color:var(--text);--w:.3s;--d:${i};--st:.35s;--t:.3s">${d}</span></li>`).join('')}</ul><p class="sm a-fade mt-s" style="--w:1.8s">The checks are real; the ticks are an example.</p></div></div></div>`,
      },
      {
        name: 'The dry run, typed',
        cost: 'S S S M',
        why: 'Replace the photograph with a terminal: the command types itself and the plan prints line by line. Less pretty, more true to how it feels to use, and it costs no image bytes.',
        says: 'Here is what you will see when you run it.',
        motion:
          'On entering view, once: 22 characters at 45 ms; then four result lines, 250 ms apart; then "nothing changed" in green. Reduced motion: all printed.',
        style: st({ h: '360px' }),
        html: `<div class="card pad split"><div class="col"><p class="h2" style="font-size:clamp(22px,3.4cqi,40px)">It checks before it changes anything</p><p class="p"><b style="color:var(--text)">Read the plan first.</b> It prints the plan and every preflight result, and changes nothing.</p></div>
          <div class="code term" style="white-space:normal"><p><span class="pr">$ </span><span class="tw" style="--n:22">bothy install --dry-run</span></p>${dry.map((d, i) => `<p class="a-fade" style="--w:${1.2 + i * 0.25}s;--t:.2s"><span class="ok-t">ok</span>  ${d}</p>`).join('')}<p class="a-fade ok-t" style="--w:2.4s;--t:.2s">plan printed, nothing changed</p><p class="a-fade" style="--w:2.4s"><span class="ex">EXAMPLE output</span></p></div></div>`,
      },
      {
        name: 'Checks flow into a verdict',
        cost: 'M S S M',
        why: 'Four check nodes on the left, each joined by a line to one verdict on the right; a light travels along each line in turn and the verdict lights when all four have arrived. A diagram of "every check must pass".',
        says: 'All four must pass, or nothing happens.',
        motion:
          'Loop while visible: a short amber light runs along each line (2.6 s, ease-out, 350 ms apart), transform only; the verdict glows. Stops off screen and with reduced motion (lines and verdict still drawn).',
        style: st({ h: '360px' }),
        html: `<p class="h2" style="font-size:clamp(22px,3.4cqi,40px)">It checks before it changes anything</p>
          <div class="beams mt">${dry.map((d, i) => `<div class="bn"><span class="card pad-s sm" style="color:var(--text)">${d}</span><span class="bl"><i class="lp-beam" style="--d:${i}"></i></span></div>`).join('')}<div class="verdict gl pad"><span class="tk">✓</span> <b>Plan printed.</b><br><span class="sm">Nothing changed.</span></div></div>`,
      },
    ],
  });

  // 12 Four-up feature row ------------------------------------------------------------------------------
  const feats = [
    ['shield', 'Verified releases.', 'Checked against their own checksums, every image pulled by digest.', 'sha256'],
    ['repeat', 'Safe to run twice.', 'In our lab a second install changed nothing.', '≈1 s'],
    [
      'alert',
      'Refuses with the fix.',
      'A taken port, a stopped Docker or too little memory: nothing is created and the message says why.',
      'Refused',
    ],
    [
      'home',
      'Leaves as found.',
      'bothy uninstall removes what it added and keeps your data unless you purge.',
      'Undone',
    ],
  ];
  const proven = [
    'Stock install on a clean Ubuntu 24.04 machine',
    'sha256 checked before anything changes',
    'Every image pulled by digest',
    'A second run changed nothing',
    'A tampered release was refused',
    'Uninstall and purge removed what they should',
    'A taken port was refused with the fix named',
  ];
  add({
    id: 'features',
    group: H,
    title: 'Four-up feature row',
    now: 'Under a hairline, four columns each with a small boxed icon and one sentence with a bold lead.',
    weak: 'Small icons and grey text at the end of a long section read as an afterthought; four short promises get less space than one example panel above.',
    ref: 'Owner reference 4 (stats row: huge figures or words with a small muted line, hairline tops), Tailscale and Supabase icon rows, marquee strips.',
    opts: [
      {
        name: 'Big words under hairlines',
        rec: true,
        cost: 'S S S S',
        why: "The owner's stats row adapted: each column leads with one huge word or measured figure (sha256, about 1 s, Refused, Undone) and a short muted line under it. The only number is the measured re-run time.",
        says: 'Four guarantees, each one checkable.',
        motion:
          'On entering view: hairlines draw from the start edge (600 ms, 80 ms apart); big words rise 18 px out of a mask (700 ms); lines fade after. Reduced motion: still.',
        style: st({ h: '300px' }),
        html: `<ul class="g4">${feats.map((f, i) => `<li class="hl2"><span class="hlr a-sx" style="--d:${i};--t:.6s"></span><p class="mask"><span class="big a-line" style="--d:${i};--w:.2s">${f[3]}</span></p><p class="sm mt-s a-fade" style="--w:.5s;--d:${i}"><b style="color:var(--text)">${f[1]}</b> ${f[2]}</p></li>`).join('')}</ul><p class="sm mt">≈1 s: a second install in our lab took 0.9 s (release 2026.11.2). Measured, not promised.</p>`,
      },
      {
        name: 'Tiles with a moving icon',
        cost: 'S S S S',
        why: 'Four small tiles; each icon does one tiny thing that means what it says when the tile arrives or is pointed at: the shield ticks, the arrows turn, the alert shakes once, the house settles.',
        says: 'Small things, done carefully.',
        motion:
          'On entering view: tiles rise 70 ms apart; each icon plays once (pop, a half turn, a shake, a drop; 500 to 700 ms). Hover or focus lifts a tile 3 px (220 ms) and replays its icon. Reduced motion: still.',
        style: st({ h: '280px' }),
        html: `<ul class="g4" data-spot>${feats.map((f, i) => `<li class="card pad spot feat a-up" style="--d:${i};--st:.07s" tabindex="0"><span class="ico ${['a-pop', 'a-swing', 'a-stamp', 'a-drop'][i]}" style="--w:.4s;--t:.7s">${svg(f[0])}</span><p class="sm mt-s"><b style="color:var(--text)">${f[1]}</b> ${f[2]}</p></li>`).join('')}</ul>`,
      },
      {
        name: 'Proof marquee',
        cost: 'S S S M',
        why: 'A slow strip of every claim proven in the lab, passing behind the four promises. It shows there are more proofs than fit on a card, and each chip links to the record.',
        says: 'There is a lot of evidence, and it is all written down.',
        motion:
          'Loop: the strip moves at about 30 px a second (40 s a lap), edges fade out; pauses on hover and on focus; stops off screen. Reduced motion: the chips wrap into a still list.',
        style: st({ h: '300px' }),
        html: `<div class="marq" tabindex="0" aria-label="Proven in our lab"><div class="marq-track lp-marq">${[...proven, ...proven].map((p, i) => `<span class="chip ok"${i >= proven.length ? ' aria-hidden="true"' : ''}>✓ ${p}</span>`).join('')}</div></div>
          <ul class="g4 mt">${feats.map((f) => `<li>${ic(f[0])}<p class="sm mt-s"><b style="color:var(--text)">${f[1]}</b> ${f[2]}</p></li>`).join('')}</ul>`,
      },
    ],
  });

  // 13 Closing band -------------------------------------------------------------------------------------
  add({
    id: 'cta',
    group: H,
    title: 'Closing band',
    now: 'Night sky with a dither edge: a huge centred four-line heading (two white lines, two grey), two pills, and a small "Tested in our lab…" note.',
    weak: 'Four lines at display size fill the screen; the grey half is low contrast over stars; it repeats on every page, so on About and Releases it is a second, louder page end.',
    ref: 'Owner reference 2 (huge two-tone heading left, two pills right with small print under, a giant faint cropped wordmark with cursor-lit glass edges, a hairline, then the footer).',
    opts: [
      {
        name: 'Heading left, pills right, lit wordmark',
        rec: true,
        cost: 'M S S S',
        why: "The owner's reference: the heading on the left in two tones, the two pills and the small print on the right, then the giant faint BothyBox cropped at the bottom edge, its letters catching a light that follows the pointer. It ends the page without shouting.",
        says: 'That is everything. Here is the door.',
        motion:
          'On entering view: heading lines rise 120 ms apart; pills fade 300 ms later. Pointer: a 300 px soft light follows the pointer across the wordmark (no loop). Touch and reduced motion: the wordmark stays faint and still.',
        style: st({ h: '440px', pad: '0' }),
        html: `<div data-lit class="cta-a"><div class="split cta-split" style="align-items:end"><p class="d" style="font-size:clamp(28px,4.3cqi,58px)"><span class="a-up" style="display:block">Give your machine a shelter.</span><span class="a-up grey" style="display:block;--d:1;--st:.12s">Free, open, and plain about it.</span></p>
          <div class="col a-fade" style="align-items:end;--w:.3s"><span class="flex"><span class="pill lit">Install Bothy</span><span class="pill">Read the docs</span></span><p class="sm" style="text-align:end;max-inline-size:36ch">Tested in our lab on Linux amd64 with Docker and Compose. Bivvy is the size that installs today.</p></div></div>
          <div class="wm-wrap" aria-hidden="true"><span class="wordmark">BothyBox</span><span class="wordmark litwm">BothyBox</span></div><hr class="hr" /></div>`,
      },
      {
        name: 'Night sky, magnetic button',
        cost: 'S S M M',
        why: 'Keep the night and the centred heading but at two lines, with stars that slowly twinkle and an Install button that leans toward the pointer as it comes near. One focal point, one action.',
        says: 'Go on, it is one command.',
        motion:
          'Loop: stars twinkle (opacity, 2.4 to 4.5 s, stop off screen). Pointer within 140 px: the button moves up to 6 px toward it (350 ms ease-out), back on leave. Keyboard focus: the ring only. Reduced motion: still stars, no lean.',
        cls: 'sky ctr',
        style: st({ img: 'var(--night)', h: '400px' }),
        html: `<span class="stars" aria-hidden="true">${stars(22)}</span><div data-mag class="col" style="align-items:center;justify-content:center;min-block-size:330px"><p class="d" style="font-size:clamp(28px,6cqi,76px)">Give your machine a shelter.</p><p class="p">Free, open, and plain about it.</p><span class="flex mt-s"><span class="pill lit mag">Install Bothy</span><span class="pill">Read the docs</span></span><p class="sm mt-s">Tested in our lab on Linux amd64 with Docker and Compose.</p></div>`,
      },
      {
        name: 'The command is the button',
        cost: 'S S S S',
        why: "A product that installs with one command can end on that command: one wide pill with the Cube, the dry-run command and Copy. When it arrives, the Cube's lid lifts once, the same gesture as the splash.",
        says: 'You could start right now.',
        motion:
          'On entering view: heading rises; the pill pops from 96 %; the Cube lid lifts 10 px and tilts 18 degrees, then settles (1.2 s, once). Copy turns into "Copied" for 1.5 s. Reduced motion: no lid.',
        style: st({ h: '360px' }),
        html: `<div class="col ctr" style="align-items:center;justify-content:center;min-block-size:290px"><p class="h2 a-up">Give your machine a shelter.</p><p class="p a-up" style="--d:1">Read the plan first. It changes nothing.</p>
          <div class="cmdpill gl a-pop" style="--s:.96;--w:.3s" data-copybox>${cube(30, 'a-lid" style="--w:.6s;--t:1.2s;transform-box:fill-box')}<span class="mono">bothy install --dry-run</span><button type="button" class="pill lit" data-copy="bothy install --dry-run">Copy</button></div><p class="sm">Then <span class="kbd">bothy install</span>. Linux amd64 with Docker.</p></div>`,
      },
    ],
  });

  // 14 Footer ---------------------------------------------------------------------------------------------
  const fcols = [
    ['Product', ['Install', 'Modes', 'Releases', 'About']],
    ['Resources', ['Documentation', 'Installing guide', 'Source code', 'Test record']],
    ['Legal', ['Licence (MIT)', 'Security policy', 'Privacy', 'Accessibility']],
  ];
  const fine =
    '<p class="sm">© 2026 Yehuda Briskman. Released under the MIT licence.</p><p class="sm">Newest release: 2026.11.2 · No scripts from other sites, no analytics, no cookies.</p>';
  add({
    id: 'footer',
    group: H,
    title: 'Footer',
    now: 'A giant faint BOTHYBOX in capitals cropped at the top, a hairline, a brand column with two round icon buttons, three link columns, and a fine-print row.',
    weak: 'The wordmark is in capitals while the brand is set "BothyBox"; it sits directly under the closing band\'s own giant heading, so two giant type moments touch; the right-edge chapter dots overlap it.',
    ref: 'Owner reference 2 (four-column footer with round glass social buttons under the wordmark), Tailscale and Linear footers.',
    opts: [
      {
        name: 'Four columns, glass buttons',
        rec: true,
        cost: 'S S S S',
        why: "The owner's reference, which is close to what we have: keep the four columns, set the wordmark in the real case (BothyBox) and let the closing band own it (option 13A), and make the two round buttons glass with a light edge.",
        says: 'Everything else, in its place.',
        motion:
          'Almost none, by design: columns fade in 60 ms apart; round buttons brighten on hover or focus (150 ms). Reduced motion: still.',
        style: st({ h: '300px' }),
        html: `<div class="g4"><div class="col a-fade">${lock(20)}<p class="sm">A small console for the machine you run things on. Free and open source.</p><span class="flex"><a class="rbtn" href="#footer" aria-label="Source on GitHub">${svg('code')}</a><a class="rbtn" href="#footer" aria-label="Releases">${svg('tag')}</a></span></div>${fcols.map((c, i) => `<nav class="col a-fade" style="--d:${i + 1};--st:.06s" aria-label="${c[0]}"><b class="sm" style="color:var(--text)">${c[0]}</b>${c[1].map((l) => `<a class="flink" href="#footer">${l}</a>`).join('')}</nav>`).join('')}</div><div class="flex btw wrap mt hl">${fine}</div>`,
      },
      {
        name: 'One quiet line',
        cost: 'S S S S',
        why: 'If the closing band is strong, the footer can be one row: the lockup, the twelve links inline, and the fine print. Shortest page end, nothing to scroll past on the docs.',
        says: 'Done. Nothing more to sell.',
        motion:
          "None. The release chip's dot is static. (A footer is reached by people looking for one link; motion would only delay them.)",
        style: st({ h: '200px' }),
        html: `<div class="flex btw wrap">${lock(18)}<nav class="flex wrap" aria-label="Footer" style="gap:6px 16px">${fcols
          .flatMap((c) => c[1])
          .map((l) => `<a class="flink" href="#footer">${l}</a>`)
          .join(
            '',
          )}</nav></div><div class="flex btw wrap mt hl"><span class="chip"><span class="dot"></span>Newest release 2026.11.2</span><p class="sm">© 2026 Yehuda Briskman · MIT · no analytics, no cookies</p></div>`,
      },
      {
        name: 'Horizon with a lit window',
        cost: 'M S S S',
        why: 'The columns sit above a dark hill line along the bottom edge, with one tiny hut whose window glows amber: the page ends where the story ended, at the shelter.',
        says: 'You are always welcome back.',
        motion:
          "Loop while visible: the window's glow breathes very slowly (opacity 100 to 25 %, 3.2 s); nothing else moves. Reduced motion: lit, still.",
        style: st({ h: '320px' }),
        html: `<div class="g4">${fcols.map((c) => `<nav class="col" aria-label="${c[0]}"><b class="sm" style="color:var(--text)">${c[0]}</b>${c[1].map((l) => `<a class="flink" href="#footer">${l}</a>`).join('')}</nav>`).join('')}<div class="col">${lock(20)}${fine}</div></div>
          <svg class="horizon" viewBox="0 0 1000 90" preserveAspectRatio="none" aria-hidden="true"><path d="M0 90 V60 Q180 20 380 52 T760 40 T1000 50 V90Z" fill="#11131b"/><path d="M700 46 L716 34 L732 46 V58 H700Z" fill="#1d2030"/><rect x="711" y="46" width="10" height="9" fill="#ffd58a"/><circle class="lp-tw" cx="716" cy="50" r="9" fill="rgb(255 213 138 / 35%)"/></svg>`,
      },
    ],
  });
})();
