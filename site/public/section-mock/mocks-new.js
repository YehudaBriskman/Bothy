// Mocks for four proposed NEW home page sections (21 to 24): the parts up close, see it in motion, the four sizes
// compared, and under the hood. Words are the site's own (site/src/i18n/en.ts), the measured facts in
// site/src/facts.ts, or the example fixtures in site/fixtures/console/. Anything invented is marked EXAMPLE.
(() => {
  const { svg, ic, EX, st } = window.MOCK;
  const add = (s) => window.SECTIONS.push(s);
  const G = 'New sections (proposed)';

  // Shared pieces -------------------------------------------------------------------------
  const fw = (title, body, o = {}) =>
    `<div class="fw ${o.cls || ''}" ${o.attr || ''}><div class="fw-bar"><span class="flex" style="gap:0"><span class="dots" aria-hidden="true"><i></i><i></i><i></i></span><b>${title}</b></span>${o.noex ? '' : EX}</div><div class="fw-body">${body}</div></div>`;
  // The example services fixture (site/fixtures/console/services.json): name, state, group.
  const SV = [
    ['Notes web', 'up', 'notes'],
    ['Notes API', 'up', 'notes'],
    ['Notes DB', 'up', 'notes'],
    ['Wiki', 'starting', 'wiki'],
    ['Dev server', 'unknown', 'host'],
    ['Nightly backup', 'stopped', 'backup'],
  ];
  const svcRows = (o = {}) =>
    SV.map(([n, s, g], i) => {
      const chip =
        o.flip && s === 'starting'
          ? `<span class="xf"><span class="xf-a s-starting"><i class="sd"></i>starting</span><span class="xf-b s-up"><i class="sd"></i>up</span></span>`
          : `<span class="s-${s}"><i class="sd"></i>${s}</span>`;
      return `<tr class="${o.cls || ''}${o.flip && s === 'starting' ? ' lp-row' : ''}" ${o.cls ? `style="--d:${i}"` : ''}><td>${n}</td><td>${chip}</td><td style="color:var(--faint)">${g}</td></tr>`;
    }).join('');
  const svcTbl = (o) =>
    `<table class="mini-t"><thead><tr><th>Service</th><th>State</th><th>Group</th></tr></thead><tbody>${svcRows(o)}</tbody></table>`;
  const tiles = (flip = false) => {
    const t = [
      ['Services', flip ? 'x' : '5', ' / 6 up', flip ? 'x' : '0 down · 1 off', ''],
      ['Routes', '3', ' / 3', 'enabled', ''],
      ['Updates', '1', ' available', 'largest: wiki', ''],
      ['Last backup', '11h', ' ago', 'every set is fresh', ''],
    ];
    return `<div class="tiles4">${t
      .map(([l, n, of, sub], i) => {
        if (i === 0 && flip)
          return `<div class="vt"><small>${l}</small><span class="xf"><b class="xf-a">5<span> / 6 up</span></b><b class="xf-b" style="color:var(--warn)">4<span> / 6 up</span></b></span><br><span class="xf"><em class="xf-a">0 down · 1 off</em><em class="xf-b" style="color:var(--warn)">1 down · 1 off</em></span></div>`;
        return `<div class="vt"><small>${l}</small><b>${n}<span>${of}</span></b><br><em>${sub}</em></div>`;
      })
      .join('')}</div>`;
  };
  const filesBody = `<div style="display:grid;grid-template-columns:.8fr 1.4fr;gap:12px"><div class="ftree"><span>README.md</span><span>▾ setup</span><span class="on-f" style="margin-inline-start:10px">first-run.md</span><span style="margin-inline-start:10px">ports.md</span><span>▸ journal</span><span>recipes.md</span></div><div class="rd"><h5>First run</h5><p>Bothy asks Docker what is running and lists it as <b style="color:var(--text)">services</b>. It does not change those containers.</p><p style="margin-top:6px"><code>docker compose ps</code></p><p style="margin-top:6px"><span class="chip">Writing: read-only</span></p></div></div>`;
  const modsRows = [
    ['edge', 'core', '128', true],
    ['web', 'core', '64', true],
    ['files', '', '256', true],
    ['node-metrics', '', '64', false],
  ];
  const modsBody = `<table class="mini-t"><thead><tr><th>Module</th><th class="n">Memory limit</th><th>State</th></tr></thead><tbody>${modsRows.map(([n, c, m, i]) => `<tr><td>${n}${c ? ' <span style="color:var(--faint)">(core)</span>' : ''}</td><td class="n">${m} MiB</td><td class="${i ? 's-up' : 's-unknown'}"><i class="sd"></i>${i ? 'installed' : 'not installed'}</td></tr>`).join('')}</tbody></table>`;
  const play = `<svg class="i-play" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5v11l9.5-5.5z"/></svg><svg class="i-pause" viewBox="0 0 14 14" aria-hidden="true"><path d="M3 1.5h3v11H3zM8 1.5h3v11H8z"/></svg>`;
  const cur = (cx, cy) =>
    `<span class="k-cur" style="--cx:${cx}cqi;--cy:${cy}cqi" aria-hidden="true"><svg viewBox="0 0 14 14"><path d="M1 1l11 4.5-4.6 1.6L5.8 12z"/></svg></span>`;

  // The four clips. The stage draws a stand-in with CSS; the site would carry a silent, looping, captioned video.
  const CLIPS = [
    {
      id: 'services',
      name: 'Services',
      len: 8,
      cap: 'Bothy asks Docker what is running and lists it. A starting service turns up on its own.',
      scene: () =>
        fw('Services', svcTbl({ cls: 'k-in', flip: true }), {}) + cur(34, 41),
      script:
        'The Services table fills row by row: three notes services up, the wiki starting, a dev server unknown, a nightly backup stopped. A pointer moves to the wiki row. Its state changes from starting to up.',
      shot: '0 s hold the filled table, Wiki "starting" (start it 3 s before recording). 2 s pointer to the Wiki row. 4 s its chip flips to up (healthcheck start period set to 4 s). 8 s hold, loop point.',
    },
    {
      id: 'files',
      name: 'Notes',
      len: 10,
      cap: 'A reader for the notes kept on the machine. It only reads: the page says so.',
      scene: () => fw('Files', filesBody, {}) + cur(24, 25),
      script:
        'The Files tab shows a tree of example notes. A pointer opens setup, then first-run.md. The page renders as text with a code block. A chip on the page says Writing: read-only.',
      shot: '0 s tree collapsed. 1.5 s open "setup". 3 s click first-run.md. 5 s scroll to the code block. 8 s hover the read-only chip. 10 s hold, loop point.',
    },
    {
      id: 'health',
      name: 'Health',
      len: 6,
      cap: 'Four vitals on one strip. Stop a service and the strip says so.',
      scene: () => fw('Overview', tiles(true), {}),
      script:
        'The overview shows four tiles: services 5 of 6 up, routes 3 of 3, one update, the last backup 11 hours ago. A service stops and the first tile changes to 4 of 6 up, one down, in amber.',
      shot: '0 s hold the strip, all up. 2 s stop one container from a hidden terminal (docker stop notes-cache). 3 to 4 s the tile changes tone. 6 s hold, loop point. Check on the real app that the strip refreshes inside 3 s; if not, speed it up in the edit and say so in the caption.',
    },
    {
      id: 'install',
      name: 'Install',
      len: 12,
      cap: 'Read the plan, then install. Shortened: a real install takes 24 to 39 seconds in our lab.',
      scene: () =>
        fw(
          'Terminal',
          `<p class="tline k-in" style="--d:0"><span class="pr">$ </span>bothy install --dry-run</p><p class="tline k-in dim" style="--d:2">Docker answers, Compose v2 present</p><p class="tline k-in dim" style="--d:3">At least 960 MiB of memory free</p><p class="tline k-in dim" style="--d:4">Port 80 is free</p><p class="tline k-in dim" style="--d:5">sha256 matches checksums.txt</p><p class="tline k-in" style="--d:7"><span class="pr">$ </span>bothy install</p><p class="tline k-in ok" style="--d:9">Bivvy is up: http://&lt;addr&gt;:&lt;port&gt;/</p>`,
          {},
        ),
      script:
        'In a terminal, bothy install --dry-run prints four checks and stops. Then bothy install runs, shortened, and ends on the line "Bivvy is up" with the address.',
      shot: '0 s type the dry run (typed at human speed, 40 ms a key). 2 to 5 s the four checks print. 6 s type bothy install. 7 to 11 s the output, cut to 5 s with a visible "shortened" badge. 11 s the Bivvy-is-up line, hold. Never show a time that the real run did not take.',
    },
  ];
  const clip = (c, o = {}) => {
    const badge = o.badge === undefined ? `<span class="badge">${c.len} s loop</span>` : o.badge;
    return `<div class="clip" data-clip data-playing="true" style="--len:${c.len}s" role="group" aria-roledescription="video" aria-label="${c.name}: silent clip, ${c.len} seconds, loops">
      <div class="scene" aria-hidden="true">${c.scene()}</div>
      <div class="poster" aria-hidden="true"><span>Poster · press play</span></div>${badge}
      <div class="bar"><button class="clipbtn" type="button" data-clip-toggle aria-label="Pause ${c.name} clip" data-name="${c.name}">${play}</button><span class="prog2" aria-hidden="true"><i></i></span><span class="len">0:${String(c.len).padStart(2, '0')}</span></div>
    </div>
    <div class="clip-meta"><p class="cap2" id="cap-${o.pre || ''}${c.id}"><b>${c.name}.</b> ${c.cap}</p>
      <details><summary>Transcript</summary><p>${c.script}</p></details>
      ${o.shot ? `<details><summary>How we record it</summary><p>${c.shot}</p></details>` : ''}</div>`;
  };

  // 21 The parts, up close ----------------------------------------------------------------
  add({
    id: 'parts',
    group: G,
    title: 'The parts, up close',
    now: 'Not on the page as its own section. The console shows once in the pinned story, and the two photo cards show an overview and a file list as small floating panels.',
    weak: 'A visitor never sees the health strip or the module list at all, and the services table is only ever seen small and moving. Nobody can look at one piece and judge how finished it is.',
    ref: 'Linear and Raycast (the product as the picture: pieces of the real UI in frames), Zed (the product UI is the visual), Supabase (a grid of capabilities, each with a picture).',
    opts: [
      {
        name: 'Four windows in a bento',
        rec: true,
        cost: 'S S S S',
        why: 'The four real pieces of the console, each in its own framed window with one line under it: the services table, the health strip, a note being read and the module list. Drawn from the same example fixtures the site already prerenders, so there are no new images and nothing to download.',
        says: 'These are the parts. Each one is small, and each one is finished.',
        motion:
          'On entering view: windows rise 18 px and fade, 90 ms apart, on the emphasised curve (700 ms). Hover or focus within a cell lifts it 3 px (400 ms). Nothing loops. Reduced motion: still.',
        style: st({ h: '620px' }),
        html: `<p class="eb">The parts</p><h4 class="h2 mt-s" style="max-inline-size:20ch">Four pieces, up close.</h4><div class="bento2 mt">
          <div class="cell a-up" style="--d:0">${fw('Services', svcTbl())}<p class="cap2"><b>What is running.</b> Found by asking Docker; nothing to register.</p></div>
          <div class="cell a-up" style="--d:1">${fw('Overview', tiles())}<p class="cap2"><b>Four vitals.</b> Services, routes, updates, the last backup.</p></div>
          <div class="cell a-up" style="--d:2">${fw('Files', filesBody)}<p class="cap2"><b>Notes where they live.</b> Read-only by design.</p></div>
          <div class="cell a-up" style="--d:3">${fw('Modules', modsBody)}<p class="cap2"><b>What is installed.</b> The limits are the ones declared in the repository.</p></div></div>`,
      },
      {
        name: 'A fan of windows',
        cost: 'M M S M',
        why: 'Three windows overlap like papers on a desk; pointing at one, or choosing its name, brings it to the front and straightens it. One picture shows depth and that the console is a set of separate pieces. At phone width the fan becomes a plain stack.',
        says: 'A desk with a few things on it, not a wall of screenshots.',
        motion:
          'Pointer, focus or the buttons: the chosen window straightens, rises 8 px and scales to 1.03 (600 ms emphasised) while the others dim to 80 %. Initial entrance: windows slide in from the foot, 120 ms apart. Reduced motion: no tilt, the front window is just marked.',
        style: st({ h: '470px' }),
        html: `<p class="eb">The parts</p><div class="fan mt-s" data-fan>
          ${fw('Services', svcTbl(), { attr: 'data-p="0"' })}${fw('Overview', tiles(), { attr: 'data-p="1" data-front' })}${fw('Files', filesBody, { attr: 'data-p="2"' })}</div>
          <div class="fan-pick" role="group" aria-label="Bring a window to the front">${['Services', 'Overview', 'Files'].map((n, i) => `<button class="pill" type="button" data-pick="${i}" aria-pressed="${i === 1}">${n}</button>`).join('')}</div>`,
      },
      {
        name: 'Windows that are alive',
        cost: 'M S M S',
        why: 'The same four windows as option A, with one slow, small motion in each: the wiki row warms and flips to up, the strip changes one figure, a row is highlighted in the tree, a module row lights. It shows the product is live without a video. Costs a few small loops that stop off screen.',
        says: 'It is running right now, and it is quiet about it.',
        motion:
          'Loops of 9 s while visible: the wiki state crossfades 120 ms, the services tile crossfades from 5 to 4 of 6 up and back, a row highlight fades in and out. Only opacity and a background colour. They pause on hover and with pause-all. Reduced motion: still, in the first state.',
        style: st({ h: '620px' }),
        html: `<p class="eb">The parts</p><h4 class="h2 mt-s" style="max-inline-size:20ch">Four pieces, running.</h4><div class="bento2 mt">
          <div class="cell">${fw('Services', svcTbl({ flip: true }))}<p class="cap2"><b>What is running.</b> Found by asking Docker.</p></div>
          <div class="cell">${fw('Overview', tiles(true))}<p class="cap2"><b>Four vitals.</b> One changes when a service stops.</p></div>
          <div class="cell">${fw('Files', filesBody)}<p class="cap2"><b>Notes where they live.</b> Read-only by design.</p></div>
          <div class="cell">${fw('Modules', modsBody)}<p class="cap2"><b>What is installed.</b> Declared limits.</p></div></div>`,
      },
    ],
  });

  // 22 See it in motion ----------------------------------------------------------------
  add({
    id: 'motion',
    group: G,
    title: 'See it in motion (video slots)',
    now: 'No video anywhere. The story section animates a drawn console; the rest of the page is still.',
    weak: 'The owner will record the real app on example data. The page has no slot for it, no rule for how it loads, and no way to make it available to a reader who cannot or should not watch it (captions, a transcript, reduced motion, a phone on a mobile plan).',
    ref: 'Linear and Zed (autoplaying muted product loops inside a frame), Warp and Raycast (a looping clip with a text description beside it), Vercel (short silent demos per feature). Seen in search; see the doc for what was fetched.',
    opts: [
      {
        name: 'One player, four chapters',
        rec: true,
        cost: 'M S M S',
        why: 'A single framed player with four chapter buttons: Services, Notes, Health, Install. Each chapter is its own 6 to 12 second silent loop with a poster, a visible play and pause button, a caption underneath and a transcript. Only the chapter you are on can load, so a visitor who never presses anything downloads one poster and no video.',
        says: 'Here is the real thing, four short looks.',
        motion:
          'The chapter marker slides on the emphasised curve (320 ms). Switching crossfades the poster in 250 ms; the clip starts only if the visitor chose it or the loop is allowed (see the rules in the doc). A 3 px amber bar shows the loop position. Reduced motion: posters only, no autoplay; the play button still starts a clip the visitor chose.',
        style: st({ h: '560px' }),
        html: `<p class="eb">In motion</p><div class="mt-s" data-tabs>
          <div role="tablist" aria-label="Clips" class="chap">${CLIPS.map((c, i) => `<button role="tab" type="button" aria-selected="${i === 0}"><span>${c.name}</span><small>0:${String(c.len).padStart(2, '0')}</small></button>`).join('')}</div>
          ${CLIPS.map((c, i) => `<div data-panel="${i}" ${i ? 'hidden' : ''}>${clip(c, { shot: true, pre: 'a-' })}</div>`).join('')}</div>`,
      },
      {
        name: 'Three poster cards, play on request',
        cost: 'S S S S',
        why: 'Three cards in a row, each a still poster in a window frame with a play button. Nothing loads until a visitor presses one; then that card plays in place. The most conservative option for bytes and for people on phones, and it needs the least script.',
        says: 'Press to see it. We will not make the page heavier for you.',
        motion:
          'On entering view: cards rise 18 px, 90 ms apart. Press: the poster fades 400 ms and the loop starts; press again to pause. Only one card plays at a time. Reduced motion: still posters; a pressed clip plays (a visitor choice).',
        style: st({ h: '470px' }),
        html: `<p class="eb">In motion</p><div class="g3 mt-s" style="align-items:start">${CLIPS.slice(0, 3)
          .map(
            (c, i) =>
              `<div class="a-up" style="--d:${i}">${clip({ ...c, len: c.len }, { badge: '', pre: 'b-' }).replace('data-playing="true"', 'data-playing="false"')}</div>`,
          )
          .join('')}</div>`,
      },
      {
        name: 'The clip follows the scroll',
        cost: 'L M L M',
        why: 'Apple-style: the clip is pinned and its time is tied to the scroll position, with a caption for each stage beside it. Impressive and fully under the visitor\'s hand, but it needs a video with a keyframe on every frame (large files), a scrubbing script, and it cannot be paused because it is not playing. Shown here with four stills standing in for frames.',
        says: 'You hold the remote.',
        motion:
          'Scroll inside the box: the frame changes at each quarter and the matching caption lights. In the site: a video with every frame a keyframe, currentTime set from scroll in a requestAnimationFrame callback. Reduced motion: the frames are a normal vertical sequence of four posters.',
        style: st({ h: '470px' }),
        html: `<p class="eb">In motion</p><div class="scrub-sc mt-s" data-scroll-frames tabindex="0" aria-label="Scrub demo, scrollable"><div class="tall"><div class="stick"><div class="clip frames" data-at="0" data-playing="false" style="aspect-ratio:16/10;position:relative">${CLIPS.map((c, i) => `<div data-frame="${i}" aria-hidden="true">${c.scene()}</div>`).join('')}</div><div class="steps-t">${CLIPS.map((c, i) => `<p ${i ? '' : 'data-on'}><b style="color:inherit">${i + 1}. ${c.name}.</b> ${c.cap}</p>`).join('')}</div></div></div></div>`,
      },
    ],
  });

  // 23 The four sizes, compared -------------------------------------------------------
  const M = ['bivvy', 'bothy', 'basecamp', 'cairn'];
  const Y = '<span class="yes">Yes</span>';
  const N = '<span class="no">No</span>';
  const PK = '<span class="pk">You pick</span>';
  const NM = '<span class="no">Not yet measured</span>';
  const rowsM = [
    ['grp', 'What it includes'],
    ['The console: services, health, modules', Y, Y, Y, PK],
    ['A read-only reader for your notes', Y, Y, Y, PK],
    ['Metrics, logs, alerts and backups', N, Y, Y, PK],
    ['Dashboards, single sign-on, a database, a cluster view', N, N, Y, PK],
    ['grp', 'Where it stands'],
    ['Installs today', '<b class="yes">Yes</b>', '<span class="no">Planned, not built</span>', '<span class="no">Planned, not built</span>', '<span class="no">Planned. The building block, <code>bothy module add</code>, is tested on a simulated machine only</span>'],
    ['Memory in our lab, after install', '<b>38 MiB</b> across three containers', NM, NM, NM],
    ['Free memory the installer wants first', '<b>960 MiB</b>', NM, NM, NM],
  ];
  const tagl = ['a roof, a door, a lock', 'four walls and a fire', 'everything before the climb', 'stack your own stones'];
  const mtable = (o = {}) =>
    `<div style="overflow-x:auto"><table class="mtab" ${o.attr || ''}><caption class="sr">The four sizes compared: what each includes and where it stands</caption><thead><tr><th scope="col"><span class="sr">Row</span></th>${M.map((m, i) => `<th scope="col" data-c="${m}"><span class="mn">${m[0].toUpperCase() + m.slice(1)}</span><span class="mt2">${tagl[i]}</span></th>`).join('')}</tr></thead><tbody>${rowsM
      .map((r) =>
        r[0] === 'grp'
          ? `<tr class="grp"><th colspan="5" scope="colgroup">${r[1]}</th></tr>`
          : `<tr class="${o.cls || ''}"><th scope="row">${r[0]}</th>${r
              .slice(1)
              .map((c, i) => `<td data-c="${M[i]}">${c}</td>`)
              .join('')}</tr>`,
      )
      .join('')}</tbody></table></div>`;
  const stackItems = [
    ['The console', 'services, health, modules', 0],
    ['The notes reader', 'read-only', 0],
    ['Metrics, logs, alerts, backups', '', 1],
    ['Dashboards, single sign-on, a database, a cluster view', '', 2],
  ];
  add({
    id: 'compare',
    group: G,
    title: 'The four sizes, compared',
    now: 'The Four sizes chapter in the story is a hill with four stops and a card each; it explains the names but cannot be compared line against line.',
    weak: 'A visitor who wants to know "what do I get at each size, and what does it cost?" has to read four cards and remember. The honest answer (only the smallest installs, and only it has a measured cost) is easy to lose in a polished table.',
    ref: 'Tailscale and Supabase pricing and plan pages (a plan table with the current plan marked), Linear (plans as columns).',
    opts: [
      {
        name: 'A table that says what is real',
        rec: true,
        cost: 'S S S S',
        why: 'One table, four columns, with Bivvy lit in amber because it is the only one that installs. Pointing at or focusing a size name (or its button) dims the other three. Where there is no measurement the cell says so, in the same grey as the planned sizes, so nothing reads as a promise.',
        says: 'Here is each size. Here is what is built, and what is not.',
        motion:
          'On entering view: rows fade and rise 8 px, 40 ms apart. Choosing a size: the other columns fade to 38 % in 300 ms (opacity only). Reduced motion: still; the choice still dims.',
        style: st({ h: '560px' }),
        html: `<p class="eb">Four sizes</p><div class="flex wrap mt-s" role="group" aria-label="Highlight a size" data-colfocus>${['All', ...M].map((m, i) => `<button type="button" class="pill" data-cf="${i ? m : ''}" aria-pressed="${i === 0}" style="text-transform:capitalize">${m}</button>`).join('')}</div><div class="mt-s a-up" data-colfocus-tbl>${mtable({ attr: 'data-mt' })}</div>`,
      },
      {
        name: 'Climb the ladder',
        cost: 'M S S S',
        why: 'Four steps on the left (the sizes, smallest first) and the list of what you have on the right. Choosing a bigger size adds lines to the list with a short amber outline on the new ones. It shows how the sizes build on each other, which a table does not.',
        says: 'Each size is the one before, plus something.',
        motion:
          'Choosing a size (a radio group with arrow keys): new lines enter 8 px low and fade in 400 ms, 60 ms apart; a line keeps its amber outline for 1.4 s. Reduced motion: the lines appear at once.',
        style: st({ h: '440px' }),
        html: `<p class="eb">Four sizes</p><div class="ladder mt" data-ladder><div class="seg2" role="radiogroup" aria-label="Size">${M.map((m, i) => `<button type="button" role="radio" aria-checked="${i === 0}" tabindex="${i === 0 ? 0 : -1}" data-s="${i}"><b style="text-transform:capitalize">${m}</b><span>${tagl[i]}${i ? '' : ' · installs today'}${i ? ' · planned' : ''}</span></button>`).join('')}</div>
          <div><ul class="stack-l" aria-live="polite">${stackItems.map(([a, b, lv]) => `<li data-lv="${lv}" ${lv ? 'hidden' : ''}><span><b>${a}</b></span><small>${b}</small></li>`).join('')}</ul><p class="sm mt-s" data-ladder-note>Installs today. About 38 MiB across its three containers in our lab.</p></div></div>`,
      },
      {
        name: 'Three questions',
        cost: 'M M S M',
        why: 'Three yes/no questions (do you want metrics and logs; single sign-on; to pick pieces yourself) and an answer: which size fits, and what is built. It is friendly, but it is a quiz about a product with one installable size, so most paths end at "start with Bivvy; this is planned". The risk is that it feels like a promise.',
        says: 'Tell us what you need and we will tell you where to start.',
        motion:
          'Answering: the result card cross-fades (250 ms) and its heading changes. No other motion. Reduced motion: instant.',
        style: st({ h: '440px' }),
        html: `<p class="eb">Four sizes</p><div class="split mt" data-quiz style="align-items:start"><div class="qz">
          <fieldset><legend>Do you want metrics, logs and alerts?</legend><label><input type="radio" name="q1" value="0" checked /> Not yet</label><label><input type="radio" name="q1" value="1" /> Yes</label></fieldset>
          <fieldset><legend>Do you want single sign-on and a cluster view?</legend><label><input type="radio" name="q2" value="0" checked /> No</label><label><input type="radio" name="q2" value="1" /> Yes</label></fieldset>
          <fieldset><legend>Would you rather pick the pieces yourself?</legend><label><input type="radio" name="q3" value="0" checked /> No</label><label><input type="radio" name="q3" value="1" /> Yes</label></fieldset></div>
          <div class="qz-out" aria-live="polite"><p class="eb" data-q-eb>Start with</p><p class="h3" data-q-h style="text-transform:none">Bivvy</p><p class="sm mt-s" data-q-p>It installs today. About 38 MiB across its three containers in our lab.</p></div></div>`,
      },
    ],
  });

  // 24 Under the hood ------------------------------------------------------------------------
  const FACTS = [
    [
      'Your browser',
      'The address is the machine and one port. By default the port is open on the machine itself only; you choose to widen it.',
    ],
    [
      'The edge',
      'Traefik, with the file provider only: it has no Docker socket (one read-only folder of routes), no dashboard, and publishes the one host port. About 15 MiB in our lab.',
    ],
    [
      'The console',
      'The web console that shows what is running. About 3.4 MiB in our lab.',
    ],
    [
      'The notes reader',
      'Read-only three times over: the policy, a read-only mount and no write routes at all (twelve read routes are exposed). About 19.6 MiB in our lab.',
    ],
  ];
  const factsBox = (i) =>
    `<div class="fact" aria-live="polite"><p class="cap2" data-fact><b>${FACTS[i][0]}.</b> ${FACTS[i][1]}</p></div>`;
  add({
    id: 'hood',
    group: G,
    title: 'Under the hood',
    now: 'Nothing on the home page shows how the pieces fit. The trust section lists claims (verified releases, safe to run twice) but not the shape of the thing; the docs hold that.',
    weak: 'The people who read a dev tool carefully (and they are most of the people who install one) look for where the Docker socket is and what is exposed. The answer is good and not visible.',
    ref: 'Tailscale (diagrams over decoration, trust as checkable facts), Warp (a code block with numbered callouts), Ghostty and Fly (terminal-first pages).',
    opts: [
      {
        name: 'The request path',
        rec: true,
        cost: 'S S S S',
        why: 'A browser, the edge, and two services, joined by lines that a point of light runs along once. Each box is a button; choosing it shows its real, measured fact under the diagram (what the edge cannot do, that the reader cannot write). One diagram, four facts, no invented numbers.',
        says: 'Nothing here is hidden, and the dangerous door is not there.',
        motion:
          'On entering view: one amber point runs along each of the three lines (900 ms, 160 ms apart) and loops slowly while visible. Choosing a box: the fact crossfades in 250 ms. Reduced motion: lines still, no point.',
        style: st({ h: '470px' }),
        html: `<p class="eb">Under the hood</p><h4 class="h2 mt-s" style="max-inline-size:22ch">Three containers and one open door.</h4><div class="flow mt" data-flow data-facts="${JSON.stringify(FACTS).replace(/"/g, '&quot;')}">
          <div class="nodes"><button class="node" type="button" data-n="0" aria-pressed="true"><small>Reaches it</small><b>Your browser</b></button></div>
          <div class="cn" aria-hidden="true"><span class="link-l"><i class="lp-beam" style="--t:2.6s"></i></span></div>
          <div class="nodes"><button class="node edge-n" type="button" data-n="1" aria-pressed="false"><small>One port, no Docker socket</small><b>The edge</b></button></div>
          <div class="cn two" aria-hidden="true"><span class="link-l"><i class="lp-beam" style="--t:2.6s;--d:1"></i></span><span class="link-l"><i class="lp-beam" style="--t:2.6s;--d:2"></i></span></div>
          <div class="nodes">
            <button class="node" type="button" data-n="2" aria-pressed="false"><small>Shows what runs</small><b>The console</b></button>
            <button class="node" type="button" data-n="3" aria-pressed="false"><small>Reads your notes</small><b>The notes reader</b></button></div></div>
          ${factsBox(0)}`,
      },
      {
        name: 'Layers, peeled',
        cost: 'M S S S',
        why: 'A stack of three rounded layers: the machine (Linux amd64, Docker and Compose), the three containers with their measured memory beside their declared limits, and your data (kept when you uninstall). Reads top to bottom as a cutaway. It makes the small size concrete: three numbers.',
        says: 'This is all of it, top to bottom, and this is how big.',
        motion:
          'On entering view, bottom to top: each layer rises 24 px and fades, 200 ms apart (700 ms emphasised), like layers being added. Reduced motion: still.',
        style: st({ h: '470px' }),
        html: `<p class="eb">Under the hood</p><div class="mt-s"><div class="lyr">
          <div class="lay a-up" style="--d:2;--st:.2s"><div class="flex btw"><b>Your notes and data</b><small class="sm">Kept when you uninstall; pulled images and secrets stay too</small></div></div>
          <div class="lay a-up" style="--d:1;--st:.2s"><div class="flex btw"><b>Docker Compose: three containers</b><small class="sm">Memory in our lab, and the limit declared</small></div><div class="sub"><div>The edge<b>15 MiB</b><span class="sm">limit 128 MiB</span></div><div>The console<b>3.4 MiB</b><span class="sm">limit 64 MiB</span></div><div>The notes reader<b>19.6 MiB</b><span class="sm">limit 256 MiB</span></div></div></div>
          <div class="lay a-up" style="--d:0;--st:.2s"><div class="flex btw"><b>The machine</b><small class="sm">Linux amd64 with Docker and Compose v2</small></div><p class="sm">The installer wants 960 MiB free before it starts: 448 MiB of limits plus a 512 MiB reserve.</p></div></div></div>`,
      },
      {
        name: 'Commands, with real output',
        cost: 'S S S M',
        why: 'The command strip the owner mentioned, folded into this section: three tabs in a terminal frame (install --dry-run, module list, update --check), each showing what it prints, and one line of plain words under it. It is the most honest "show me" for a CLI product. The output is marked EXAMPLE because it is drawn from the repository\'s own fixtures and docs, not captured from a run; a recorded capture would replace it.',
        says: 'This is what it actually says back to you.',
        motion:
          'Choosing a tab: the lines print in, 60 ms apart (opacity and an 8 px rise, 300 ms). No typewriter: the text is selectable and a screen reader reads it as it stands. Reduced motion: instant.',
        style: st({ h: '470px' }),
        html: `<p class="eb">Under the hood</p><div class="tstrip mt-s" data-tabs><div role="tablist" aria-label="Commands" class="tl-tabs">${['bothy install --dry-run', 'bothy module list', 'bothy update --check'].map((t, i) => `<button role="tab" type="button" aria-selected="${i === 0}">${t}</button>`).join('')}</div>
          <div class="out-b"><div data-panel="0"><p class="tline"><span class="pr">$ </span>bothy install --dry-run</p><p class="tline dim a-up" style="--d:1;--st:.06s">Docker answers, Compose v2 present</p><p class="tline dim a-up" style="--d:2;--st:.06s">At least 960 MiB of memory free</p><p class="tline dim a-up" style="--d:3;--st:.06s">Port 80 is free</p><p class="tline dim a-up" style="--d:4;--st:.06s">sha256 matches checksums.txt</p></div>
          <div data-panel="1" hidden><p class="tline"><span class="pr">$ </span>bothy module list</p>${modsRows.map(([n, c, m, i], k) => `<p class="tline dim a-up" style="--d:${k + 1};--st:.06s">${`${n.padEnd(14)} ${(i ? 'installed' : 'not installed').padEnd(14)} ${m} MiB`.replace(/ /g, '&nbsp;')}</p>`).join('')}</div>
          <div data-panel="2" hidden><p class="tline"><span class="pr">$ </span>bothy update --check</p><p class="tline dim a-up" style="--d:1;--st:.06s">up to date: this box already matches release 2026.11.2</p></div></div>
          <p class="note">${EX} The output is drawn from the example fixtures and the lab record, not captured from a run. <b style="color:var(--text)">bothy doctor</b> is left out on purpose: it is not shown to run in the lab record, so it is not shown here.</p></div>`,
      },
    ],
  });
})();
