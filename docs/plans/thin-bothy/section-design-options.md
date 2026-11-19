# Section design options: three ideas, with motion, for every section

Status: proposal, 2026-11-19. Nothing here is wired into `site/src`. The live mocks are in
`site/public/section-mock/` (a dev page, like `scene-mock/` and `brand-mock/`, and kept out of the shipped
budgets and the a11y gate the same way).

**To look at it:** serve `site/public` (not the mock folder alone, because the mocks borrow the existing sky
photographs from `../sky/` and `../scene-mock/img/` instead of copying them) and open `/section-mock/`:

```sh
python3 -m http.server 4196 --bind 0.0.0.0 --directory site/public
# then open http://<box>:4196/section-mock/
```

Each section has its three options side by side or one at a time. **Replay** reruns an option's motion. The
**Scrub** slider stands in for scrolling. **Pause all motion** is at the bottom of the index. With reduced motion
set, every panel shows its finished state. The panels use the site's tokens (ink `#09090c`, glass, amber lit
state), the real sky photographs and the cube icon. The words come from `en.ts`, `facts.ts` and
`fixtures/releases.json`. Anything made up, such as a services list or a terminal's output, is marked
**EXAMPLE**.

How to read the costs: **S / M / L** is the cost to build (_effort_), the chance of getting it wrong (_risk_),
the cost to the page's bytes and frames (_perf_), and the cost to accessibility (_a11y_). **★** marks the
recommended option.

## The direction in one paragraph

**"Sky above, ink below, light where it matters."** The sky stays where the story is: the hero, the descent,
the photo windows in cards, and once more at night for the trust section. Everything else is ink with
hairlines. Motion has one personality, _settling_: things rise a little and come to rest on the emphasised
curve (`cubic-bezier(.2,0,0,1)`, 600 to 1100 ms). Nothing loops forever except slow, small, pausable things,
such as a star twinkle or one window glow. The only accent is **amber, used as "lit"**: the active step, the
ticked check, the installable size, the cube lid. Numbers appear only when they were measured (38 MiB, 960 MiB,
4 roles, 5 themes, 0.9 s re-run), and they count up once. The owner's four reference layouts become the house
pattern for section heads (giant heading left, muted lede right), feature cards (a photo window first, then a
caption that starts with a bold lead phrase), the trust block (heading and claims left, hairline link rows
right, a wide glass band) and the closing band (two-tone heading, pills right, a giant faint lit wordmark).

### Recommended set (★) at a glance

| #   | Section                       | Recommended                                             | E / R / P / A |
| --- | ----------------------------- | ------------------------------------------------------- | ------------- |
| 01  | Nav and dropdown              | A Condensing capsule                                    | S S S S       |
| 02  | Hero                          | A Words rise, one name                                  | S S S S       |
| 03  | Story console                 | A Pinned window, step rail                              | M M M M       |
| 04  | Descent and "What a bothy is" | A Clouds part                                           | M M M S       |
| 05  | What is inside                | A Header, cards and a stats row (owner ref 4)           | S S S S       |
| 06  | Four sizes (modes)            | A Up the hill                                           | M S S S       |
| 07  | Install chapter               | A Numbered rail                                         | M S S S       |
| 08  | Trust                         | A Built in the open (owner ref 3)                       | S S S S       |
| 09  | After-story intro             | A Two-column header (owner ref 4 head)                  | S S S S       |
| 10  | Two-up photo cards            | A Window first, caption under (owner ref 1)             | S S S S       |
| 11  | Wide dry-run card             | A Checks tick in order                                  | S S S S       |
| 12  | Four-up features              | A Big words under hairlines (owner ref 4 stats)         | S S S S       |
| 13  | Closing CTA band              | A Heading left, pills right, lit wordmark (owner ref 2) | M S S S       |
| 14  | Footer                        | A Four columns, glass buttons (owner ref 2)             | S S S S       |
| 15  | About                         | A Lines that light as you read                          | S S S M       |
| 16  | Releases                      | A Timeline with folded releases                         | S S S S       |
| 17  | Docs index                    | A Search first                                          | M S S S       |
| 18  | Docs article                  | A Contents that follow you                              | S S S S       |
| 19  | Install page                  | A Pick a path, see only that path                       | M S S S       |
| 20  | 404                           | A Lost in the cloud                                     | S S S S       |

The total is small on purpose. Thirteen of the twenty picks are S effort. The M picks are the console rail,
the descent parallax, the hill, the install rail, the closing band, the docs search and the install-path
switch. None of them needs a library. Each one is CSS keyframes, CSS scroll-driven animation
(`animation-timeline: view()` / `scroll()`) with an IntersectionObserver fallback, or a few lines of script.

**Other combinations that hold together:**

- _Product-forward:_ hero C (split, with the console rising), console B (tab-switch shot), inside B (bento),
  CTA C (the command is the button). This shows more of the product on the first screen, at the cost of
  some calm.
- _Night ending:_ the recommended set, but with trust C (the night returns) and CTA B (night sky, magnetic
  button), so the page goes from day to dusk to night. It costs one more large photograph.
- _Minimum change:_ nav C, hero A, inside A, features A, CTA A and footer B. Every one of these is S effort;
  it is a week of work, not a redesign.

## The owner's reference layouts, and where they went

| Reference (from Zephium, patterns to mine, not to copy)                                                                                                                                 | Adopted as                                                                                                                                                                                                                                                    |
| --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1. Big heading and muted lede; two dark cards each with a framed sky window holding a floating glass panel; a caption under the window (bold lead, muted rest); a wide third card below | **10A** Window first, caption under (★), and 11A for the wide card. Alternatives: 10B (parallax windows) and 10C (sticky stacking)                                                                                                                            |
| 2. A huge two-tone heading left, two pills right with small print, a giant faint cropped wordmark lit at the cursor, a hairline, a four-column footer with round glass buttons          | **13A** (★) and **14A** (★). Alternatives: 13B (night sky, magnetic), 13C (the command is the button), 14B and 14C                                                                                                                                            |
| 3. "Built in the open" on a night-cloud photo: heading and paragraph left, an avatar stack with counts, four hairline link rows right, a wide glass band with an email field and a pill | **08A** (★), with the honest changes: **no avatar stack or star and contributor counts** (we have none we can show truthfully), and **no email field** (the site collects nothing). The band holds the dry-run command and Copy instead                       |
| 4. Two-column header, three equal dark cards (icon, title, line), a four-up stats row with hairline tops (huge figure, small unit)                                                      | **05A** (★) uses four cards and four real numbers: 38 MiB (Bivvy's three containers in our lab), 960 MiB (the free-memory gate), 4 roles, 5 themes. **09A** uses the header alone; **12A** uses the stats row with words (sha256, about 1 s, Refused, Undone) |

## Inventory: the site now

Screenshotted from `npm run build` with headless Chromium, GL off, at 1440 px wide. The **Now** and **Weak**
lines under each section below are from those shots. Patterns that recur:

- **No section owns a layout.** Most blocks are a centred heading and then a grid of equal cards, so the page
  reads as one long list.
- **Motion is either none or the sky.** Below the story, nothing moves to show what changed, what is
  active, or what was checked.
- **Real numbers are buried in prose** (38 MiB, 960 MiB, 0.9 s), where they are the strongest thing we can say.
- **The other pages are plain documents.** About, Releases, the docs and 404 have no sense of place. Releases
  is about 8,700 px tall, and you have to read every line to learn how big a release was.

## Research: what was looked at

Each source is described in my own words; no text or assets were copied. **Verified** means the page was
fetched and read in this work. **Snippet** means it was seen only in search results. **Prior** means it is
known from before and was not re-checked; treat it as a pointer, not as evidence.

| Source                                                                                                                     | What it shows                                                                                                                        | Status                           |
| -------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------ | -------------------------------- |
| https://linear.app/                                                                                                        | Dark product page; product shots right under the hero; sections separated by hairlines; small, settling motion                       | Verified                         |
| https://tailscale.com/                                                                                                     | Plain explanatory sections, diagrams over decoration, trust stated as checkable facts                                                | Verified                         |
| https://www.raycast.com/                                                                                                   | Category tabs over a card grid; a split feature layout with a mock UI; a closing centred CTA; a multi-column footer                  | Verified                         |
| https://zed.dev/                                                                                                           | The product's own UI as the hero visual; three linked cards in a row; a minimal footer                                               | Verified                         |
| https://www.warp.dev/                                                                                                      | A code block with numbered callouts, a numbered list beside it, an install command inside a product card; a footer with social icons | Verified                         |
| https://cal.com/                                                                                                           | Feature sections each with a heading, a short list and a link; case-study cards with metric bullets; no closing band                 | Verified                         |
| https://supabase.com/                                                                                                      | A product grid of six capabilities; a "what do you want to do" lookup as the call to action                                          | Verified (text only)             |
| https://developer.mozilla.org/en-US/docs/Web/API/View_Transition_API                                                       | Same-document and cross-document view transitions (`@view-transition`)                                                               | Verified                         |
| https://developer.chrome.com/docs/css-ui/scroll-driven-animations                                                          | `animation-timeline: scroll()` and `view()`, ranges, running off the main thread                                                     | Verified                         |
| https://magicui.design/docs/components/animated-beam                                                                       | Lines that carry a light from nodes to a target (dry-run C)                                                                          | Verified (partial)               |
| https://scroll-driven-animations.style/                                                                                    | Demos including stacking cards and reading progress (two-up C, docs-article B)                                                       | Snippet                          |
| https://codyhouse.co/tutorials/how-stacking-cards                                                                          | Sticky stacking cards that scale as the next one covers them                                                                         | Snippet                          |
| https://frontendmasters.com/blog/glowing-hover-effect/                                                                     | A pointer-following glow and edge light on cards (inside C)                                                                          | Snippet                          |
| https://dev.to/ibelick (spotlight border)                                                                                  | A spotlight border made with a radial gradient and a mask                                                                            | Snippet                          |
| https://developer.chrome.com/blog/ (interactive content reveal)                                                            | Scroll-linked text reveals (about A)                                                                                                 | Snippet                          |
| https://linear.app/now/how-we-redesigned-the-linear-ui                                                                     | The reasoning behind a calmer, denser dark UI                                                                                        | Snippet                          |
| https://linear.app/blog (design refresh, liquid glass)                                                                     | Glass panels kept for overlays only                                                                                                  | Snippet                          |
| https://vercel.com/, https://arc.net/, https://ghostty.org/, https://resend.com/, https://fly.io/, https://www.framer.com/ | Hero type, terminal-first heroes, changelog timelines, a giant cropped wordmark in the footer                                        | Prior                            |
| https://www.apple.com/                                                                                                     | Pinned product with captions changing beside it while you scroll (console A, about C)                                                | Prior                            |
| https://www.awwwards.com/, https://godly.website/, https://land-book.com/                                                  | Galleries used only to check how common a pattern is                                                                                 | Prior                            |
| Zephium (the owner's screenshots, and `zephium-study.md`)                                                                  | The four reference layouts above                                                                                                     | Owner-supplied; site not fetched |

**Patterns** used across the options: bento grids (5B), sticky stacking cards (10C), scroll-linked reveals
(4A, 15A), number tickers and count-ups (5A), a marquee (12C), spotlight and glow borders (5C, 17B), tab-switch
product shots (3B), a terminal typewriter (7B, 11B), animated beams (11C), parallax windows (4A, 10B), a
magnetic button (13B), text mask reveals (2B, 9A, 12A), a camera over a canvas (3C) and a sticky gutter (16C).
View transitions are proposed for moving between pages (a docs link to its article, a release row to its
release), not mocked, because a single page cannot show them.

## Rules every option follows

- Only `transform` and `opacity` animate, plus CSS scroll-driven timelines. Each has an IntersectionObserver
  or static fallback.
- `prefers-reduced-motion: reduce` gives the finished state with no movement. Loops stop off screen and pause
  on hover or focus.
- Every interactive piece is a real button or link. Tabs use the APG tab pattern (arrow keys), the
  disclosures use `aria-expanded`, and focus is visible.
- No number that was not measured. Placeholder data says **EXAMPLE** on the screen.
- No new images: the mocks reuse the four `sky/*-desk.webp` and the `scene-mock` AVIFs. The whole gallery is
  about 170 KB of text, and the largest mock is well under 30 KB.

## Section by section

### 01 Navigation and the install dropdown (`#nav`)

**Now.** Lockup left, five text links in the middle, a GitHub pill and a split "Install" pill on the right; the chevron opens a glass panel (platforms, the dry-run command, three links).

**Weak.** The bar is full width and heavy over the sky; the links are plain text with no hover state you can see; the panel is a long single column and appears with no sense of where it came from.

|     | Option                   | Effort | Risk | Perf | A11y |
| --- | ------------------------ | ------ | ---- | ---- | ---- |
| A ★ | Condensing capsule       | S      | S    | S    | S    |
| B   | Two-column install panel | M      | S    | S    | S    |
| C   | Sliding hover pill       | S      | S    | S    | S    |

**A. Condensing capsule (recommended).** Over the hero the bar is nothing but text on the sky; once you scroll it gathers into one centred glass capsule, so the sky stays clean and the nav is still always there. _Says:_ Quiet, careful, out of the way. _Motion:_ Scroll-linked over the first 120 px: background 0 to glass, scale 1 to 0.9, links pull in. Dropdown: 180 ms, ease-out, fade plus 6 px drop, rows staggered 30 ms. Reduced motion: the capsule state, no drop.

**B. Two-column install panel.** The dropdown is the shortest path to installing. Laid out wide, platforms on one side and the command on the other, it reads in one glance instead of a scroll. _Says:_ This is exactly what runs where, and here is the command. _Motion:_ Click: panel 200 ms ease-out from the button (scale 0.97 to 1, origin top right). Left rows stagger 40 ms; the command types itself once (45 ms a character), then the caret rests.

**C. Sliding hover pill.** A soft glass pill slides under whichever link you point at or tab to, so the nav answers the pointer and the keyboard the same way; the panel grows out of the button that opened it. _Says:_ Responsive and precise, like the console itself. _Motion:_ Pointer or focus: the pill moves in 320 ms on the emphasised curve (transform and width). Dropdown: scale 0.9 to 1 from the button corner, 220 ms, with a 12 px blur-free fade. Reduced motion: the pill jumps.

### 02 Hero: the sky (`#hero`)

**Now.** A live sky photograph, a pill "Installs on Linux with Docker", a small serif BothyBox, a very large centred headline, a lede and two pills.

**Weak.** Two names stacked (the serif BothyBox and the headline) compete; the serif mark does not match the lockup in the nav; nothing on screen shows the product; the scroll cue is weak.

**Looked at.** Zephium hero (per-word rise, chip with a moving highlight), Raycast and Linear (product shot right under the headline).

|     | Option                        | Effort | Risk | Perf | A11y |
| --- | ----------------------------- | ------ | ---- | ---- | ---- |
| A ★ | Words rise, one name          | S      | S    | S    | S    |
| B   | The lit window                | M      | M    | S    | S    |
| C   | Split with the console rising | M      | M    | M    | S    |

**A. Words rise, one name (recommended).** Keep the sky and the centred stack, drop the duplicate serif name for the real lockup, and let the headline arrive word by word as the sky settles. The cheapest change with the biggest calm. _Says:_ A place, not a pitch. _Motion:_ Load: words rise 18 px and fade, 1.1 s emphasised, 45 ms apart; lede at 0.55 s; buttons at 0.7 s. The chip edge carries one conic highlight that turns once (4.5 s) and stops. Reduced motion: all drawn complete.

**B. The lit window.** Open on dusk, with the Cube large and its amber lid glowing like a lit window; the headline is unmasked line by line beneath it. It ties the hero to the brand splash the owner chose. _Says:_ Somebody left the light on for you. _Motion:_ Load: Cube fades up, its lid glow breathes once (2.4 s); headline lines slide up out of a mask, 800 ms emphasised, 90 ms apart; buttons fade at 0.9 s. Reduced motion: still.

**C. Split with the console rising.** Words on the left, the real console on the right rising out of the clouds and tilting flat as you scroll. The visitor sees the product in the first screen, which none of the current hero does. _Says:_ This is a real thing you can look at. _Motion:_ Load then scroll: the window starts 60 px low, tilted 22 degrees back at 94 %, and settles flat over the first screen of scroll (scroll-linked). Text rises 18 px, 80 ms apart. Reduced motion: flat and still.

### 03 Story: the console, step by step (`#console`)

**Now.** A large framed console (tabs Services, Files, Health, Modules; EXAMPLE DATA chip) pinned over the sky while seven numbered steps play; a caption under it.

**Weak.** The frame is big and the step list sits under it as a plain numbered list, so the eye has to go down and back up; nothing on the table shows which step is being talked about; the caption repeats the list.

**Looked at.** Zephium (one persistent window, captions swap under it, a camera over a larger canvas), Supabase and Resend (tab switch with progress).

|     | Option                   | Effort | Risk | Perf | A11y |
| --- | ------------------------ | ------ | ---- | ---- | ---- |
| A ★ | Pinned window, step rail | M      | M    | M    | M    |
| B   | Tab-switch product shot  | S      | S    | S    | S    |
| C   | Camera over the canvas   | L      | M    | M    | M    |

**A. Pinned window, step rail (recommended).** Keep one window pinned, move the seven steps into a slim rail beside it and highlight the part of the table each step talks about. The story and the evidence are in the same place. _Says:_ This is the whole tour, and you can see where you are. _Motion:_ Scroll-linked in the site (autoplay here, 3.2 s a step): the rail marker slides on the emphasised curve (320 ms), the caption crossfades and rises 8 px (280 ms), the matching row lights. Click or arrow keys pick a step. Reduced motion: no autoplay.

**B. Tab-switch product shot.** Four tabs that are the console's own tabs; each shows its screen with a one-line caption. Familiar from developer sites, light, and complete without scroll tricks. _Says:_ Four things it does, each one real. _Motion:_ Autoplay 4 s a tab with a thin amber progress bar, stops for good on the first click or focus. Indicator slides 320 ms emphasised; panels crossfade and rise 8 px in 280 ms. Reduced motion: no autoplay, instant swap.

**C. Camera over the canvas.** One large console canvas sits behind a fixed frame; for each step the camera glides and zooms to the part being described while the rest dims. Detail stays readable on a phone without a second mock-up. _Says:_ Look here. Now here. _Motion:_ Scroll-linked in the site; here click the steps. The canvas moves with transform only, 700 ms on the emphasised curve; a vignette dims what is out of focus. Reduced motion: whole canvas, no moves.

### 04 Story: the descent and the hut (`#descent`)

**Now.** Chapter 1 "What a bothy is" (a glass card with the Bothy Code) and chapter 2 "One console for one machine" (a glass card on the right) over scene backdrops that cross-fade.

**Weak.** Without WebGL or before the backdrops load both chapters are a single card on black; the cards are the same shape as every other card, so the story does not feel like it moves down a hill.

**Looked at.** Apple product pages (scroll-scrubbed scenes), Zephium (sky exit), site/public/scene-mock (our own backdrops).

|     | Option                | Effort | Risk | Perf | A11y |
| --- | --------------------- | ------ | ---- | ---- | ---- |
| A ★ | Clouds part           | M      | M    | M    | S    |
| B   | The window lights     | M      | S    | S    | S    |
| C   | The Bothy Code, dealt | S      | S    | S    | S    |

**A. Clouds part (recommended).** Three of our own cloud photographs as layers that move at different speeds as you scroll, so you pass through cloud to the hut. The card stays plain and readable on top. _Says:_ You are coming down out of the sky. _Motion:_ Scroll-linked: the far layer moves 8 %, the middle 16 %, the near one 30 % and fades; the card rises 18 px as it enters. Transform and opacity only. Scrub to see it. Reduced motion: one still layer.

**B. The window lights.** A simple hut on a dark hill; as the chapter arrives its window turns on, amber, and the words "One console for one machine" come up beside it. A small, memorable beat that needs no photograph. _Says:_ Here is the shelter. It is open. _Motion:_ On entering view: hill and hut fade in (600 ms), the window goes from dark to amber in 400 ms after 0.6 s, its glow breathes once; text rises 18 px, 80 ms apart. Reduced motion: lit from the start.

**C. The Bothy Code, dealt.** The four rules of the Bothy Code are the soul of the name; give each its own card, dealt onto the table one after another, instead of four rows in a box. _Says:_ These are the manners the software keeps. _Motion:_ On entering view: cards fall into place from 24 px above with a 4 degree turn that settles to 0, 500 ms emphasised, 120 ms apart. Reduced motion: laid out still.

### 05 What is inside (`#inside`)

**Now.** Heading, lede, then four equal glass cards in a three-column grid (Overview, Files, Roles, Themes), so the fourth sits alone on a second row; a small note under them.

**Weak.** Three columns for four items leaves a hole; every card is text only, so nothing shows; the cards float (bob) which reads as decoration, not information.

**Looked at.** Owner reference 4 (two-column header, three dark cards with a white icon, a stats row with hairline tops); Linear and Vercel (spotlight cards); bento grids.

|     | Option                        | Effort | Risk | Perf | A11y |
| --- | ----------------------------- | ------ | ---- | ---- | ---- |
| A ★ | Header, cards and a stats row | S      | S    | S    | S    |
| B   | Bento with live tiles         | M      | M    | S    | S    |
| C   | Spotlight cards               | S      | S    | S    | M    |

**A. Header, cards and a stats row (recommended).** The owner's reference layout, made true: a two-column header, four equal dark cards with a white icon, then a row of real measured numbers under hairlines. The numbers are the strongest thing we can say. _Says:_ Small, and we measured it. _Motion:_ On entering view: cards rise 18 px, 70 ms apart (700 ms emphasised); hairlines draw from the start edge (600 ms); numbers count up from 0 in 1.2 s ease-out with tabular figures so nothing shifts. Reduced motion: final numbers.

**B. Bento with live tiles.** One large Overview tile and three smaller ones, each holding a tiny working piece of the console: a status line, a file list, the four roles, five theme swatches. Shows, not tells. _Says:_ Each part is real and does one thing. _Motion:_ On entering view: tiles pop from 96 %, 80 ms apart; inside, role chips light one after another (150 ms apart) and the swatches pop in a row. Reduced motion: still.

**C. Spotlight cards.** Keep four plain cards in one row and give them a soft amber light that follows the pointer across all four, lighting their edges. Keyboard focus lights the focused card the same way. _Says:_ Polished, and quietly alive. _Motion:_ Pointer: a 260 px radial light and a 1 px edge light track the pointer (CSS variables, no animation loop); they fade in over 300 ms on hover. Reveal: rise 18 px, 70 ms apart. Touch: no light. Reduced motion: no reveal, light kept (it is not motion).

### 06 Four sizes (modes) (`#sizes`)

**Now.** Four equal glass cards in a row: a state chip ("Installable now" or "Planned, not built"), the name, an italic tagline, the contents and the cost; Cairn carries a long note.

**Weak.** Four equal cards say four equal products, when only one exists; the green chip is the only difference; the Cairn note makes that card twice as tall; the names (shelters on a hill) are not used visually.

**Looked at.** Apple comparison tables, Resend and Vercel tier cards (one highlighted), segmented pickers.

|     | Option                           | Effort | Risk | Perf | A11y |
| --- | -------------------------------- | ------ | ---- | ---- | ---- |
| A ★ | Up the hill                      | M      | S    | S    | S    |
| B   | Comparison table, one lit column | S      | S    | S    | S    |
| C   | Size picker                      | S      | S    | S    | S    |

**A. Up the hill (recommended).** Draw the four sizes as places on one hill, smallest at the bottom: Bivvy lit and solid, the others outlined and dashed further up. Then the one that exists gets the detail, and the others one line each. _Says:_ Start small; the rest is a path, not a promise. _Motion:_ On entering view: the path draws up the hill (scale from the start, 900 ms), markers pop in order 150 ms apart, Bivvy's ring pulses twice. Reduced motion: drawn complete.

**B. Comparison table, one lit column.** A plain comparison table: four columns, the same rows for each. Bivvy's column is lit and solid; the planned ones are dimmed with dashed edges. Honest, scannable and printable. _Says:_ Here is exactly what each size holds, and what exists. _Motion:_ On entering view: columns rise 12 px, 90 ms apart; the lit column's edge draws top to bottom (500 ms). Hovering a column brightens it (150 ms). Reduced motion: still.

**C. Size picker.** A segmented control with the four names; one size shown at a time in a single roomy card. The planned sizes say so plainly when picked. Short on the page, and it invites a click. _Says:_ Pick the size that fits; only one is ready. _Motion:_ Click or arrow keys: the pill slides 320 ms emphasised; the card content crossfades and rises 8 px in 280 ms. Planned sizes swap the solid edge for a dashed one. Reduced motion: instant.

### 07 Install with one command (`#install-ch`)

**Now.** Heading, a terminal with the four commands, a sudo note, then two columns of text ("What it checks", "What it did", "Leaving"), a green-bordered lab note, and the two long "shown / not shown" lists.

**Weak.** It is the longest section on the page and almost all text; the terminal's first line runs off the edge; the proof lists repeat the Install page word for word; nothing guides the eye from step 1 to step 4.

**Looked at.** Warp (typed terminal), Zed and Ghostty (one command with copy), stepper rails on docs sites.

|     | Option                   | Effort | Risk | Perf | A11y |
| --- | ------------------------ | ------ | ---- | ---- | ---- |
| A ★ | Numbered rail            | M      | S    | S    | S    |
| B   | One terminal, typed      | S      | S    | S    | M    |
| C   | Checks, then what it did | S      | S    | S    | S    |

**A. Numbered rail (recommended).** Four numbered steps down a rail that fills as you scroll; each step has one short sentence and its command with a copy button. The proof lists move to the Install page and are linked. _Says:_ Four steps, in order, and you always know which one you are on. _Motion:_ Scroll-linked: the rail fills from the top (transform scaleY), the step in the middle of the view brightens and its number fills amber (150 ms). Scroll inside the box to try it. Reduced motion: full rail, all steps bright.

**B. One terminal, typed.** The four commands typed out one after another in a single terminal, each answered by a short line of output, so the whole install reads like watching someone do it once. _Says:_ This is all there is to it. _Motion:_ On entering view, once: each command types at 45 ms a character, its output appears 300 ms later, the next starts 400 ms after. Copy copies all four. Screen readers get the plain text (the cover is decoration). Reduced motion: all shown.

**C. Checks, then what it did.** Make the two lists the visual: on the left the six checks tick one after another, a divider draws, then on the right the three things it did slide in. The order is the point: check first, change after. _Says:_ It looks before it leaps. _Motion:_ On entering view: ticks pop 250 ms apart (scale 0.6 to 1, 300 ms); the divider draws down (500 ms) after the last; the right column slides in from 28 px, 120 ms apart. Reduced motion: all shown.

### 08 Leave it as you found it (trust) (`#trust`)

**Now.** Heading, "Each line here can be checked.", four bullet claims, four bordered link boxes (Source, Licence, Releases, Security policy), a hairline, the amber serif closing line and the sky footnote.

**Weak.** Bullets and boxes on a dark band: the most important promise on the site looks like fine print; link boxes have uneven heights and purple underlines that fight the palette.

**Looked at.** Owner reference 3 ("Built in the open": night cloud photograph, heading left, link rows with icon and arrow on the right, a wide glass band below).

|     | Option            | Effort | Risk | Perf | A11y |
| --- | ----------------- | ------ | ---- | ---- | ---- |
| A ★ | Built in the open | S      | S    | S    | S    |
| B   | Receipts          | S      | M    | S    | S    |
| C   | The night returns | M      | S    | M    | S    |

**A. Built in the open (recommended).** The owner's reference layout over our night sky: heading and claims on the left, four hairline link rows with an icon and an arrow on the right, and a wide glass band holding the dry-run command. No stars or contributor counts: we do not show numbers we have not got. _Says:_ Everything here can be checked, and here is where. _Motion:_ On entering view: heading rises, claims fade 80 ms apart, link rows slide in from 28 px, 90 ms apart; the band rises last. Arrow nudges 4 px on hover or focus (220 ms). Reduced motion: still.

**B. Receipts.** Each claim set as a receipt line with the place to check it, and a small "checkable" stamp that lands on each in turn. Playful, but it makes the point that these are verifiable, not adjectives. _Says:_ We kept the receipts. _Motion:_ On entering view: rows rise 70 ms apart, then each stamp drops from 180 % to 100 % with a 6 degree turn (500 ms, slight overshoot), 200 ms apart. Reduced motion: stamps in place.

**C. The night returns.** The story ends at night: the photograph zooms out slowly, a few stars come out, and the claims appear one by one, closing on the amber line in the serif. A real ending to the scroll before the dark sections. _Says:_ Rest here. Nothing is hidden. _Motion:_ On entering view: the night photo settles from 112 % (1.6 s); stars twinkle on long loops (2.4 to 4.5 s, opacity only, stop when off screen); claims fade 150 ms apart; the closing line last. Reduced motion: still night, no twinkle.

### 09 After the story: "What you get" heading (`#after-intro`)

**Now.** Eyebrow "What you get" with an amber dot, the heading "A small console, kept honest." and a muted lede, left aligned on black.

**Weak.** It is the first thing on black after the sky and it arrives with no ceremony; heading and lede stack in one narrow column leaving the right half empty.

**Looked at.** Owner reference 4 (giant heading left, muted paragraph right), owner reference 2 (two-tone heading).

|     | Option            | Effort | Risk | Perf | A11y |
| --- | ----------------- | ------ | ---- | ---- | ---- |
| A ★ | Two-column header | S      | S    | S    | S    |
| B   | Two-tone heading  | S      | S    | S    | S    |
| C   | Horizon line      | S      | S    | S    | S    |

**A. Two-column header (recommended).** Giant heading on the left, the muted lede on the right aligned to its last line, the owner's reference layout. It uses the full width and becomes the pattern for every section head that follows. _Says:_ A new part of the page starts here. _Motion:_ On entering view: each heading line slides up out of a mask (800 ms emphasised, 90 ms apart); the lede fades in after 300 ms. Reduced motion: still.

**B. Two-tone heading.** The heading's second line in grey, as in the owner's closing-band reference, so it reads as a statement and its quiet answer. Centred, with the eyebrow's amber dot pulsing once as you arrive. _Says:_ Small, and honest about it. _Motion:_ On entering view: the dot pulses once (ring 0.6 to 2.4, 2.4 s); line one rises, line two rises 120 ms later and settles at 46 % white. Reduced motion: still.

**C. Horizon line.** A thin strip of dusk sky with a hairline horizon drawing across it marks the hand-over from the story to the dark sections; the heading sits under it. A seam that remembers the sky. _Says:_ You have come down from the sky; now the details. _Motion:_ On entering view: the horizon draws from the start edge (900 ms emphasised) while a small amber light travels along it; the heading rises after 300 ms. Reduced motion: drawn.

### 10 Two photo cards: console and files (`#two-up`)

**Now.** Two dark cards side by side; title, bold lead and link at the top, then a sky photograph with a floating glass panel of EXAMPLE rows.

**Weak.** The text sits above the picture, so the cards start with words and the pictures are pushed down; the two cards differ in height because the leads wrap differently; the panels appear all at once.

**Looked at.** Owner reference 1 (Zephium: heading and two-line lede, two cards each with a framed sky window holding a floating glass panel, caption under the window with a bold lead and a muted rest, a third wide card under them).

|     | Option                           | Effort | Risk | Perf | A11y |
| --- | -------------------------------- | ------ | ---- | ---- | ---- |
| A ★ | Window first, caption under      | S      | S    | S    | S    |
| B   | Parallax windows, leaning panels | M      | S    | M    | M    |
| C   | Sticky stacking cards            | M      | M    | S    | M    |

**A. Window first, caption under (recommended).** The owner's reference, made ours: the sky window opens each card and the caption sits under it as one sentence with a bold lead. The pictures lead, the cards line up, and the third wide card starts under them. _Says:_ Look first, then read one line. _Motion:_ On entering view: cards rise 18 px (700 ms emphasised, 100 ms apart); the glass panel floats up 16 px 200 ms later; its rows follow 80 ms apart. Reduced motion: still.

**B. Parallax windows, leaning panels.** Same cards, but each photograph moves slower than the card as you scroll, so the window has depth, and the glass panel leans gently toward the pointer. A little of the hero's life carried into the cards. _Says:_ The sky is still there, behind everything. _Motion:_ Scroll-linked: the photo moves from -8 % to 8 % inside its frame (transform, scaled 118 %). Pointer: the panel tilts up to 4 degrees (400 ms ease-out back to flat). Scrub to see the parallax. Reduced motion and touch: no tilt, no parallax.

**C. Sticky stacking cards.** The console card, the files card and the dry-run card as a stack: each sticks near the top while the next slides over it, and the one behind shrinks and dims. Three ideas, one place on screen. _Says:_ One thing at a time, in order. _Motion:_ Scroll-linked (scroll inside the box): cards are position: sticky; as the next one covers it, a card scales 1 to 0.94 and dims to 65 % brightness. In the site, CSS animation-timeline: view() with a plain stack as the fallback. Reduced motion: a plain stack.

### 11 Wide card: it checks before it changes anything (`#dry-run`)

**Now.** A wide dark card: a very large heading, a bold lead with the dry-run command inline and a link on the left; a sky photograph with a "Dry run" glass panel of four ticked rows on the right.

**Weak.** The heading is set larger than the section heading above it, so the hierarchy inverts; the ticks are already ticked, so the one thing this card is about, the order of checks, is not shown.

**Looked at.** Warp (typed terminal), Magic UI animated beam, Vercel wide feature cards.

|     | Option                     | Effort | Risk | Perf | A11y |
| --- | -------------------------- | ------ | ---- | ---- | ---- |
| A ★ | Checks tick in order       | S      | S    | S    | S    |
| B   | The dry run, typed         | S      | S    | S    | M    |
| C   | Checks flow into a verdict | M      | S    | S    | M    |

**A. Checks tick in order (recommended).** Keep the layout, bring the heading down to card size, and let the four checks tick one after another, then the footer line "The checks are real; the ticks are an example." The order of the ticks is the message. _Says:_ It checks, in order, before it touches anything. _Motion:_ On entering view: rows appear dim; each tick pops (scale 0.6 to 1, 300 ms) 350 ms apart and its row brightens; the footer fades last. Reduced motion: all ticked.

**B. The dry run, typed.** Replace the photograph with a terminal: the command types itself and the plan prints line by line. Less pretty, more true to how it feels to use, and it costs no image bytes. _Says:_ Here is what you will see when you run it. _Motion:_ On entering view, once: 22 characters at 45 ms; then four result lines, 250 ms apart; then "nothing changed" in green. Reduced motion: all printed.

**C. Checks flow into a verdict.** Four check nodes on the left, each joined by a line to one verdict on the right; a light travels along each line in turn and the verdict lights when all four have arrived. A diagram of "every check must pass". _Says:_ All four must pass, or nothing happens. _Motion:_ Loop while visible: a short amber light runs along each line (2.6 s, ease-out, 350 ms apart), transform only; the verdict glows. Stops off screen and with reduced motion (lines and verdict still drawn).

### 12 Four-up feature row (`#features`)

**Now.** Under a hairline, four columns each with a small boxed icon and one sentence with a bold lead.

**Weak.** Small icons and grey text at the end of a long section read as an afterthought; four short promises get less space than one example panel above.

**Looked at.** Owner reference 4 (stats row: huge figures or words with a small muted line, hairline tops), Tailscale and Supabase icon rows, marquee strips.

|     | Option                    | Effort | Risk | Perf | A11y |
| --- | ------------------------- | ------ | ---- | ---- | ---- |
| A ★ | Big words under hairlines | S      | S    | S    | S    |
| B   | Tiles with a moving icon  | S      | S    | S    | S    |
| C   | Proof marquee             | S      | S    | S    | M    |

**A. Big words under hairlines (recommended).** The owner's stats row adapted: each column leads with one huge word or measured figure (sha256, about 1 s, Refused, Undone) and a short muted line under it. The only number is the measured re-run time. _Says:_ Four guarantees, each one checkable. _Motion:_ On entering view: hairlines draw from the start edge (600 ms, 80 ms apart); big words rise 18 px out of a mask (700 ms); lines fade after. Reduced motion: still.

**B. Tiles with a moving icon.** Four small tiles; each icon does one tiny thing that means what it says when the tile arrives or is pointed at: the shield ticks, the arrows turn, the alert shakes once, the house settles. _Says:_ Small things, done carefully. _Motion:_ On entering view: tiles rise 70 ms apart; each icon plays once (pop, a half turn, a shake, a drop; 500 to 700 ms). Hover or focus lifts a tile 3 px (220 ms) and replays its icon. Reduced motion: still.

**C. Proof marquee.** A slow strip of every claim proven in the lab, passing behind the four promises. It shows there are more proofs than fit on a card, and each chip links to the record. _Says:_ There is a lot of evidence, and it is all written down. _Motion:_ Loop: the strip moves at about 30 px a second (40 s a lap), edges fade out; pauses on hover and on focus; stops off screen. Reduced motion: the chips wrap into a still list.

### 13 Closing band (`#cta`)

**Now.** Night sky with a dither edge: a huge centred four-line heading (two white lines, two grey), two pills, and a small "Tested in our lab…" note.

**Weak.** Four lines at display size fill the screen; the grey half is low contrast over stars; it repeats on every page, so on About and Releases it is a second, louder page end.

**Looked at.** Owner reference 2 (huge two-tone heading left, two pills right with small print under, a giant faint cropped wordmark with cursor-lit glass edges, a hairline, then the footer).

|     | Option                                  | Effort | Risk | Perf | A11y |
| --- | --------------------------------------- | ------ | ---- | ---- | ---- |
| A ★ | Heading left, pills right, lit wordmark | M      | S    | S    | S    |
| B   | Night sky, magnetic button              | S      | S    | M    | M    |
| C   | The command is the button               | S      | S    | S    | S    |

**A. Heading left, pills right, lit wordmark (recommended).** The owner's reference: the heading on the left in two tones, the two pills and the small print on the right, then the giant faint BothyBox cropped at the bottom edge, its letters catching a light that follows the pointer. It ends the page without shouting. _Says:_ That is everything. Here is the door. _Motion:_ On entering view: heading lines rise 120 ms apart; pills fade 300 ms later. Pointer: a 300 px soft light follows the pointer across the wordmark (no loop). Touch and reduced motion: the wordmark stays faint and still.

**B. Night sky, magnetic button.** Keep the night and the centred heading but at two lines, with stars that slowly twinkle and an Install button that leans toward the pointer as it comes near. One focal point, one action. _Says:_ Go on, it is one command. _Motion:_ Loop: stars twinkle (opacity, 2.4 to 4.5 s, stop off screen). Pointer within 140 px: the button moves up to 6 px toward it (350 ms ease-out), back on leave. Keyboard focus: the ring only. Reduced motion: still stars, no lean.

**C. The command is the button.** A product that installs with one command can end on that command: one wide pill with the Cube, the dry-run command and Copy. When it arrives, the Cube's lid lifts once, the same gesture as the splash. _Says:_ You could start right now. _Motion:_ On entering view: heading rises; the pill pops from 96 %; the Cube lid lifts 10 px and tilts 18 degrees, then settles (1.2 s, once). Copy turns into "Copied" for 1.5 s. Reduced motion: no lid.

### 14 Footer (`#footer`)

**Now.** A giant faint BOTHYBOX in capitals cropped at the top, a hairline, a brand column with two round icon buttons, three link columns, and a fine-print row.

**Weak.** The wordmark is in capitals while the brand is set "BothyBox"; it sits directly under the closing band's own giant heading, so two giant type moments touch; the right-edge chapter dots overlap it.

**Looked at.** Owner reference 2 (four-column footer with round glass social buttons under the wordmark), Tailscale and Linear footers.

|     | Option                      | Effort | Risk | Perf | A11y |
| --- | --------------------------- | ------ | ---- | ---- | ---- |
| A ★ | Four columns, glass buttons | S      | S    | S    | S    |
| B   | One quiet line              | S      | S    | S    | S    |
| C   | Horizon with a lit window   | M      | S    | S    | S    |

**A. Four columns, glass buttons (recommended).** The owner's reference, which is close to what we have: keep the four columns, set the wordmark in the real case (BothyBox) and let the closing band own it (option 13A), and make the two round buttons glass with a light edge. _Says:_ Everything else, in its place. _Motion:_ Almost none, by design: columns fade in 60 ms apart; round buttons brighten on hover or focus (150 ms). Reduced motion: still.

**B. One quiet line.** If the closing band is strong, the footer can be one row: the lockup, the twelve links inline, and the fine print. Shortest page end, nothing to scroll past on the docs. _Says:_ Done. Nothing more to sell. _Motion:_ None. The release chip's dot is static. (A footer is reached by people looking for one link; motion would only delay them.)

**C. Horizon with a lit window.** The columns sit above a dark hill line along the bottom edge, with one tiny hut whose window glows amber: the page ends where the story ended, at the shelter. _Says:_ You are always welcome back. _Motion:_ Loop while visible: the window's glow breathes very slowly (opacity 100 to 25 %, 3.2 s); nothing else moves. Reduced motion: lit, still.

### 15 About (`#about`)

**Now.** Page head ("A shelter, kept by the people who use it."), two cards (the name with the Bothy Code; the software), a trust list with link rows, a "This site" block, then the closing band.

**Weak.** The second card is half empty; the trust section repeats the home page; long stretches of black with small grey text; the page has no picture although the story it tells is a place.

**Looked at.** Apple and Linear essays (lines that light as they cross the middle of the screen), sticky media beside scrolling text.

|     | Option                                  | Effort | Risk | Perf | A11y |
| --- | --------------------------------------- | ------ | ---- | ---- | ---- |
| A ★ | Lines that light as you read            | S      | S    | S    | M    |
| B   | The name and the software, face to face | S      | S    | S    | S    |
| C   | A window that follows the story         | M      | M    | M    | S    |

**A. Lines that light as you read (recommended).** Set the About text as a short manifesto in large type; each line is dim until it reaches the middle of the screen, then lights. It turns six facts into something you read slowly, without adding a word. _Says:_ This is what we believe, one line at a time. _Motion:_ Scroll-linked (scroll inside the box): each line's opacity goes from 22 % to 100 % by its distance from the middle. In the site, animation-timeline: view() with entry and exit ranges. Reduced motion: all lines full.

**B. The name and the software, face to face.** Two equal halves that meet at a hairline: on the left the hut (what a bothy is, the four rules ticked), on the right the software (one console for one machine). Each half fills, so neither card looks empty. _Says:_ The software borrows the name and the manners. _Motion:_ On entering view: the halves slide in from their own sides (28 px, 700 ms emphasised); the hairline draws down; the four rules tick 150 ms apart. Reduced motion: still.

**C. A window that follows the story.** A tall photo window stays beside the text while you read; it changes from day to dusk to night as you pass the name, the software and "this site". The page finally has a picture, and it is the same sky as the home page. _Says:_ Same place, different hours. _Motion:_ Scroll-linked (scroll inside the box): the window is sticky; the photograph crossfades (opacity, 600 ms) when the next part reaches the middle. Reduced motion: one still photograph.

### 16 Releases (changelog) (`#releases`)

**Now.** Page head, then one card per release with every change listed in full (83 lines for v2026.11.0), the release page and comparison links; the closing band after.

**Weak.** The page is about 8,700 px tall at desktop width, almost all of it one release; nothing gives the shape of a release (how big, what kind) before you read every line; the newest release looks like every other.

**Looked at.** Linear changelog (dates in a gutter, sticky labels), Zed releases (plain list), GitHub release pages.

|     | Option                         | Effort | Risk | Perf | A11y |
| --- | ------------------------------ | ------ | ---- | ---- | ---- |
| A ★ | Timeline with folded releases  | S      | S    | S    | S    |
| B   | Release cards with their shape | S      | S    | S    | S    |
| C   | Sticky version gutter          | S      | S    | S    | S    |

**A. Timeline with folded releases (recommended).** A vertical rail with one dot per release; the newest is open and its dot glows, the older ones are folded to one line with their size ("83 changes"). Native details elements, so it works with no script and the keyboard. _Says:_ Steady releases; here is the latest. _Motion:_ On entering view: the rail draws down (800 ms), entries fade in 80 ms apart, the newest dot pulses twice. Opening a release: its list fades and rises 6 px (220 ms). Reduced motion: still.

**B. Release cards with their shape.** Each release opens with a bar showing what kind of changes it carried (features, fixes, docs, other), counted from the real release notes, so you see at once that 2026.11.0 was a big one and 2026.11.2 a small fix. _Says:_ What changed, at a glance. _Motion:_ On entering view: each bar grows from the start edge (scaleX, 700 ms emphasised, 100 ms apart); the counts fade in after. Reduced motion: still.

**C. Sticky version gutter.** Two columns: the version and date stick in a narrow gutter while that release's changes scroll past on the right, so you never lose which release a line belongs to on a long list. _Says:_ A careful, complete record. _Motion:_ Scroll (inside the box): the gutter label is position: sticky; the next label pushes it up. Lines fade in as they enter (in the site, a view() timeline). No other motion. Reduced motion: unchanged (sticky is not motion).

### 17 Docs index (`#docs-index`)

**Now.** Page head with two notes, a left list of all pages, a search field, then three groups of two-column cards, each card a title and a truncated excerpt.

**Weak.** Every page is listed twice (sidebar and cards); the excerpts are cut mid-sentence ("will actual…"); search sits below the fold on a phone; nothing says where to start.

**Looked at.** Resend docs (organised by task), Supabase and Tailscale docs (search first, product cards), command-palette search.

|     | Option       | Effort | Risk | Perf | A11y |
| --- | ------------ | ------ | ---- | ---- | ---- |
| A ★ | Search first | M      | S    | S    | S    |
| B   | Three doors  | S      | S    | S    | M    |
| C   | I want to…   | S      | S    | S    | S    |

**A. Search first (recommended).** Put a large search field at the top with a "/" shortcut, and under it the three groups as tight lists, not cards. Typing filters the list in place. It is the fastest way to a page and the index stays one screen tall. _Says:_ You know what you want; type it. _Motion:_ Typing: rows that do not match fade to 18 % and shrink to 97 % (250 ms); the count updates. Focus: the field's ring grows in 150 ms. Reduced motion: instant.

**B. Three doors.** Three tall cards, one per group, each with an icon, a one-line purpose and its pages as links. A newcomer reads three sentences and knows which door is theirs; the spotlight makes the cards feel like doors. _Says:_ Start here, then here, then here. _Motion:_ On entering view: cards rise 90 ms apart. Pointer: the spotlight edge follows across the three (no loop); keyboard focus lights the focused card. Reduced motion: still.

**C. I want to….** A row of task chips ("install it", "use it", "run it day to day", "fix something") over the full card grid; a chip brings its pages forward and quiets the rest. Organised by what the reader is trying to do, not by our chapters. _Says:_ Tell us what you are doing. _Motion:_ Click a chip: the pressed chip fills (150 ms); cards outside the task fade to 18 % and shrink to 97 % (250 ms ease-out), so the layout never jumps. Reduced motion: instant.

### 18 Docs article (`#docs-article`)

**Now.** Three columns: the docs list on the left, the article in the middle (tables, code, long sections), "On this page" on the right; a previous and next pager at the end.

**Weak.** The right-hand contents never shows where you are; long pages (about 6,500 px) give no sense of progress; tables are dense grey boxes; the left list repeats the whole docs index on every page.

**Looked at.** Supabase and Ghostty docs (scroll-spy contents), Tailscale knowledge base (breadcrumbs, last updated), Vercel docs (reading progress).

|     | Option                           | Effort | Risk | Perf | A11y |
| --- | -------------------------------- | ------ | ---- | ---- | ---- |
| A ★ | Contents that follow you         | S      | S    | S    | S    |
| B   | Reading progress and calm tables | S      | S    | S    | S    |
| C   | One column, contents on demand   | M      | S    | S    | M    |

**A. Contents that follow you (recommended).** Keep the three columns, and make "On this page" a real guide: a small marker slides to the section you are reading. The cheapest change that makes long pages feel shorter. _Says:_ You are here. _Motion:_ Scroll (inside the box): the marker moves to the active link with transform, 220 ms ease-out; the active link brightens. Reduced motion: the marker jumps.

**B. Reading progress and calm tables.** A one-pixel amber line along the top shows how far through the page you are; tables become two-column lists with the route in mono and the meaning beside it. Long, dense pages become easier to keep going on. _Says:_ Nearly there. _Motion:_ Scroll-linked: the top line scales from 0 to 100 % across the page (in the site, animation-timeline: scroll(), no script). Reduced motion: unchanged (it reports position, it does not move things).

**C. One column, contents on demand.** Hide both side columns behind one "Contents" button and set the article in a single readable measure; heading anchors appear on hover or focus. Best on a phone, and calmer for long reading on a laptop. _Says:_ Just the text. _Motion:_ Contents button: a panel drops 8 px and fades in (180 ms ease-out), items 30 ms apart; Escape and the button close it. Anchors fade in on hover or focus (150 ms). Reduced motion: no drop.

### 19 Install page (`#install-page`)

**Now.** A long single page: "Pick a path" (two cards), requirements, "run it as your normal user", Path 1 in four numbered steps with terminals, Path 2, updating and uninstalling, the two proof lists, the archive table, "not offered yet".

**Weak.** About 7,000 px of mostly text; the choice between the two paths is made at the top and then both are shown anyway; the archive table is the only place the platforms are explained and it is at the bottom.

**Looked at.** Zed and Ghostty download pages (platform first), stepper patterns, Fly.io install docs.

|     | Option                          | Effort | Risk | Perf | A11y |
| --- | ------------------------------- | ------ | ---- | ---- | ---- |
| A ★ | Pick a path, see only that path | M      | S    | S    | S    |
| B   | A stepper you tick off          | M      | S    | S    | M    |
| C   | Platforms first                 | S      | S    | S    | S    |

**A. Pick a path, see only that path (recommended).** The two path cards become the switch: choosing one shows its steps and hides the other's. Without script both paths stay on the page in order, as now. Halves the page for everyone. _Says:_ There are two ways; you only need one. _Motion:_ Click or arrow keys: the chosen card lifts and its edge lights (220 ms); the steps crossfade and rise 8 px (280 ms). Reduced motion: instant.

**B. A stepper you tick off.** The four steps of Path 1 as a checklist: each has its command, a copy button and a "Done" box you tick yourself; a progress line fills. Kept only in the page, nothing stored. It holds your place in a long install. _Says:_ You are two steps from done. _Motion:_ Tick: the box fills (150 ms), the progress line grows to the new fraction (scaleX, 400 ms emphasised), the step dims. Reduced motion: instant.

**C. Platforms first.** Open with the six archives as tiles: Linux amd64 lit and marked "Run end to end in the lab", Linux arm64 dashed "Built, never run", the rest "Command-line client only". The honest platform story is the first thing anyone sees. _Says:_ Here is exactly what works where. _Motion:_ On entering view: tiles pop from 96 %, 60 ms apart, the tested tile last with a ring that pulses twice. Hover or focus raises a tile 3 px. Reduced motion: still.

### 20 404 (`#not-found`)

**Now.** Eyebrow "404", heading "No page here", one sentence, "Try one of these" and four pills, on black.

**Weak.** Correct and plain; nothing of the brand or the sky; no way to search for the page you meant.

**Looked at.** GitHub, Vercel and Fly.io 404s (brand mark, one way home), docs sites that put search on the 404.

|     | Option            | Effort | Risk | Perf | A11y |
| --- | ----------------- | ------ | ---- | ---- | ---- |
| A ★ | Lost in the cloud | S      | S    | S    | S    |
| B   | Search from here  | M      | S    | S    | S    |
| C   | The compass       | S      | S    | S    | S    |

**A. Lost in the cloud (recommended).** The same words, set over a cloud photograph with a little mist drifting and the Cube floating, as if the page wandered off the path. Brand, sky and a smile, at the cost of one image already cached. _Says:_ Wrong turn, no harm done. _Motion:_ Loop while visible: the mist layer drifts 6 % sideways over 26 s and back; the Cube bobs 8 px over 6 s. Pills rise on load. Reduced motion: still mist, still Cube.

**B. Search from here.** Most people who land on a 404 were looking for something specific; give them the site search right there, with the main pages listed and filtered as they type. _Says:_ Let us find what you meant. _Motion:_ Field focused on arrival (no motion). Typing: rows fade and shrink as they stop matching (250 ms). Reduced motion: instant.

**C. The compass.** A small compass whose needle swings, overshoots and settles pointing at the Home button. A hillwalker's joke that fits the bothy, and it draws the eye to the one action that matters. _Says:_ This way home. _Motion:_ On load, once: the needle rotates from -120 degrees, overshoots to 38, settles in 1.6 s (damped keyframes); the Home pill fades in as it settles. Reduced motion: needle already pointing.

## How it was checked

- Every option was screenshotted with headless Chromium at 1440 px and at 390 px (the 390 px run with
  reduced motion on), with each stage's animations seeked to the end. A third run at 1440 px seeked to 600 ms
  to see the motion in progress, for example the count-up halfway (14 of 38 MiB) and the checks part-ticked.
  Chromium on this box has no frame clock, so the screenshot script seeks with the Web Animations API and
  commits the styles before it captures.
- There were two passes of fixes from those screenshots:
  - Paragraph spacing had been zeroed by a too-specific reset.
  - The releases legend had collided with a type class.
  - The camera mock started out zoomed into a corner.
  - The closing heading wrapped into five lines.
  - At phone width, the photo cards, the sizes detail, the receipts, the comparison table and the release
    gutter were cramped.
- There were no console errors, no failed requests and no horizontal page scroll at either width. There are
  no `http(s)` references in the gallery.
- `npm run check:dist` passes. The dev-page budget went from 861 to 1150 KB (994.2 used), and the dist total
  from 2173 to 2560 KB (2216.2 used). Both are dev-page bytes, which no visitor of the real pages downloads.

## What is not verified

- **Zephium itself was not fetched.** Its patterns come from the owner's screenshots and `zephium-study.md`.
- **The sites marked Snippet or Prior were not re-read for this work.** Their descriptions may be out of date.
  Several fetches (Ghostty, Resend) failed. Supabase came back as text only, so its visual layout is not
  confirmed.
- **Scroll-linked behaviour is simulated in the gallery.** It uses inner scroll boxes and a scrub slider. On
  the site it would use `animation-timeline: view()` with a fallback, which the gallery does not exercise
  page-wide.
- **Pointer effects were not run in headless.** These are the spotlight, the lit wordmark, the magnetic
  button and tilt. They were read in code, not watched.
- **No real phone or screen reader was used.** Contrast of the muted text on photographs was judged by eye,
  not measured.
- The perf costs (S/M/L) are estimates from what each option animates. None of them was profiled in the
  real site.
