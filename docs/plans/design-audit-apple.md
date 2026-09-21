# Design audit: Bothy against the "apple-design" skill

_Written 2026-09-19. Status: batch 1 (the accessibility blockers) implemented
2026-09-21; batch 2 (tokens and the shared primitives) implemented 2026-09-22 -
see "Batch 2 as shipped" in §7. The §5 conflicts are decided in "Decisions
(approved 2026-09-21)" below §5. Batches 3-5 are not started._

**What was audited.** The Bothy portal: the live app on this box (`http://<box>/`) and
its source in `apps/bothy-web/web/src`. Every page was covered: Overview; Control
(Services, Ports, Routes, Topology, Cluster with all 9 tabs, service detail, system
detail); Files (reader/guide, Start, explorer, editor); Settings (all 13 sections
plus the theme editor). Also the dialogs, the command palette, the person and theme
menus, and the empty, loading, error, 404 and refusal states.

**The skill.** `apple-design` by emilkowalski, listed at
<https://www.ui-skills.com/skills/emilkowalski/apple-design>. The raw text came from
`github.com/emilkowalski/skills` → `skills/apple-design/SKILL.md` (23,036 bytes). It
is byte-identical to the copy another session saved from the page on 2026-09-18.
Only the design guidance was used. The skill's "Initial Response" instruction to the
agent and the page's `npx skills add` install line were ignored.

**The yardstick is not neutral.** The skill is written for gesture-heavy touch UI:
springs, flicks, sheets. Bothy is a pointer-and-keyboard operations dashboard with
almost no drag UI. Its only drag surfaces are the Files splitters, the Topology 3D
orbit, the TimeChart scrub and tab drag-to-split. So the gesture sections (R2–R6, R9,
R10.2) mostly come out N/A. The skill's foundations (R1, R7, R11, R12, R14–R16) are
where the real gaps are.

**How it was measured.**
- The app was logged in and rendered in real headless Chromium through
  playwright-core, because jsdom cannot see layout.
- Viewports: 1440×900, 820×1180 and 390×844 (touch), in the dark and light themes,
  plus reduced motion, forced colours and `contrast: more`.
- WCAG contrast ratios came from computed styles, composited over the real
  background.
- Other probes: touch targets, overflow, Tab walks, the type inventory, the motion
  inventory, and rAF-sampled transitions.
- Every CSS declaration was parsed with its file:line for the inventories.
- Nothing that changes state was triggered. Dialogs were opened and then cancelled.

**Evidence paths.**
- Screenshots are under
  `S = /tmp/claude-1000/-home-devssh-stacks/12519ec7-5194-41be-ad5b-b9b44cf9c92b/scratchpad/audit/shots/`,
  in the subfolders `shell/ control/ cluster/ files/ settings/ system/`.
- Probe scripts and JSON are in `…/scratchpad/audit/work/<area>/`.
- **The scratchpad is session-temporary.** Copy it somewhere durable if the
  screenshots need to outlive this session. (It did not survive: the `S/…` paths
  below are dead, and the file:line references are what count. Batch 1's before
  and after screenshots and its keyboard walkthrough log are kept on the box at
  `~/.local/state/bothy/design-audit/batch1/`.)
- Source paths below are relative to `apps/bothy-web/web/src/`. Line numbers are as
  of commit `4a5077c`. Other agents are editing this tree, so re-check a line before
  acting on it.

**One side effect.** Loading Settings › Users, Credentials, Audit and Backups writes
an "Admin reads" audit line by design. The sweep added a few hundred of them to the
audit log.

---

## 1. The skill as a checklist

The skill has 17 sections. Each rule has an ID, and every finding cites these IDs.

**R1 Response**
- R1.1 Give feedback on pointer-down (a `:active` press state), not on release.
- R1.2 Keep inessential latency off the input path: debounces, timers, transition
  waits, tap delay.
- R1.3 Give continuous 1:1 feedback during drags, sliders and drawers, not only at
  the end.

**R2 Direct manipulation**
- R2.1 Dragged content stays glued to the pointer and respects the grab offset.
- R2.2 Use Pointer Events with `setPointerCapture`, and keep a velocity/position
  history.

**R3 Interruptibility**
- R3.1 Never lock out input during a transition.
- R3.2 Animate from the presentation (current) value, not from the target.
- R3.3 Don't use CSS transitions or keyframes for gesture-driven motion.
- R3.4 Blend velocity when a gesture reverses.
- R3.5 Split 2D motion into independent X and Y springs.

**R4 Springs**
- R4.1 Use springs for anything the user can touch.
- R4.2 Default to critically damped springs (damping 1.0, response 0.3–0.4 s). Allow
  bounce only after a momentum gesture, never on a menu or dialog that simply
  appears.

**R5 Velocity handoff** Pass the release velocity into the spring.

**R6 Momentum projection** Choose the snap target from the projected end point
(d≈0.998).

**R7 Spatial consistency**
- R7.1 Enter and exit along the same path.
- R7.2 Anchor menus, popovers and sheets to their trigger (`transform-origin`).
- R7.3 Mirror the easing on reversible transitions.

**R8 Hint direction** In-between frames point at the outcome.

**R9 Rubber-banding** Resist progressively at boundaries instead of stopping hard.

**R10 Gesture details**
- R10.1 Tap highlights on down and commits on up, with about 10px of hit padding.
  Dragging away cancels.
- R10.2 Require about 10px of movement before committing to a drag direction.
- R10.3 Recognise gestures in parallel. Don't use recognisers that only report a
  final state.
- R10.4 Keep disambiguation delays short.

**R11 Frame-level smoothness**
- R11.1 Animate only `transform` and `opacity`. Use `will-change` where motion is
  imminent.
- R11.2 Keep per-frame change below the strobing threshold.

**R12 Materials and depth**
- R12.1 Chrome (nav, toolbars, sheets) is translucent (`backdrop-filter`), with
  content scrolling beneath it.
- R12.2 Material weight encodes hierarchy. Never stack a light translucent surface
  on another.
- R12.3 Bigger surfaces read thicker: stronger blur, deeper shadow.
- R12.4 Dim to focus: a modal gets a scrim. Parallel panels get no scrim.
- R12.5 Text over translucent material gets more contrast and weight (vibrancy).
- R12.6 Use a fade mask at the scroll edge, not a hard 1px divider under floating
  chrome.
- R12.7 Glass surfaces materialise (blur and scale together) rather than just
  fading.

**R13 Multimodal feedback** Causality, same-frame harmony, and feedback only where
it earns its place.

**R14 Reduced motion and accessibility**
- R14.1 Under `prefers-reduced-motion`, replace slides and springs with short
  cross-fades. Drop overshoot. Keep fades that help comprehension.
- R14.2 Honour `prefers-reduced-transparency`: make surfaces solid and drop the
  blur.
- R14.3 Honour `prefers-contrast: more`: near-solid backgrounds and defined borders.
- R14.4 Avoid full-viewport moving backgrounds and slow looping oscillation (about
  0.2 Hz). Ease brightness jumps such as theme changes.

**R15 Typography**
- R15.1 Tracking depends on size: negative on display text, about 0 on body,
  slightly positive on small text.
- R15.2 Leading tracks size inversely.
- R15.3 Hierarchy comes from weight, size and leading together.
- R15.4 Respect the user's text size: use `rem`/`em` so the layout scales with the
  text.
- R15.5 Default to the system font.

**R16 Foundations**
- R16.1 Purpose.
- R16.2 Agency: undo for slips. Confirm only destructive, irreversible actions, and
  sparingly.
- R16.3 Responsibility: previews and confirmations where there is risk.
- R16.4 Familiarity: things that look the same behave the same.
- R16.5 Flexibility: adapt to device and ability.
- R16.6 Simplicity: hierarchy makes the important thing obvious.
- R16.7 Craft: every value is deliberate, colour adapts to light and dark, nothing
  is misaligned or breaks at other sizes.
- R16.8 Delight.
- R16.9 Four kinds of feedback (status, completion, warning, error). Validate
  inline.
- R16.10 Wayfinding: where am I, where can I go, how do I get out. Never trap.
- R16.11 Put controls near what they affect.
- R16.12 Use specific labels.

**R17 Process** Prototype interactively, design motion and visuals together, and
review motion frame by frame.

---

## 2. Executive summary: the biggest gaps

The six area audits produced **133 raw findings: 7 P0, 47 P1, 79 P2.**

| Area | Prefix | P0 | P1 | P2 |
|---|---|---|---|---|
| Shell and Overview | SH | 1 | 6 | 15 |
| Control (no Cluster) | CT | 3 | 8 | 11 |
| Cluster and kube dialogs | CL | 2 | 8 | 15 |
| Files | FL | 1 | 6 | 14 |
| Settings and theme editor | ST | 0 | 9 | 12 |
| System-wide code review | SY | 0 | 10 | 12 |

Many raw findings are the same defect seen from different pages. Deduplicated,
they come to **~92 distinct items: 7 P0, 29 P1, 56 P2.** §3 collects 22 systemic
fixes that absorb 70 of the raw findings.

The biggest gaps, in priority order:

1. **Keyboard users get lost at dialog boundaries (P0).**
   - Every conditionally mounted dialog drops focus on `<body>` when it closes: the
     service action, every kube dialog, and a nested kube confirm that sends focus
     outside the modal that is still open.
   - The command palette lets Tab escape behind the scrim, and after that Escape no
     longer closes it.
   - Ports and Routes sort headers cannot be reached by keyboard.
   - One cause, conditional `open && <Dialog/>`, covers most of this.
     → SYS-4, SH-1, CT-1.
2. **Status fill colours are used as text (P0).** `.tag.ok` and `.tag.public` render
   in `--st-up`, the fill colour: 2.43:1 at 11px in light, with 52 instances on
   Routes. Zero-count filter chips are live controls faded to 1.9–2.4:1.
   → SYS-3, CT-3.
3. **The Cluster row menu is clipped by its own table (P0).** At 390 only one of
   its four items is visible. It has no menu keyboard model, and it is one of nine
   hand-rolled popovers, none of which animates from its trigger or out.
   → SYS-5.
4. **There is no pointer-down feedback anywhere (P1).** The app has 2 `:active`
   rules against 123 `:hover` rules, and no press state on `.btn`, chips, nav, tabs
   or menu rows. This is the skill's first rule, and the brand's own
   component-states matrix requires "Active" too. → SYS-1.
5. **Text ignores the user's font size (P1).** 481 of 503 font sizes are px and none
   are rem. At a 125% root size, only one field grows, and it breaks. The type scale
   has 43 sizes (the brand doc says 17), mostly in half-pixel steps. → SYS-13.
6. **Every navigation blanks the page (P1).** `AnimatePresence mode="wait"` fades
   the outgoing page to 0, holds it there for about 130ms, then fades in. That is
   about 560ms per route change, and under reduced motion it is still about 440ms.
   This conflicts with a brand decision (§5). → SYS-8.
7. **Overlays are inconsistent and have no exit motion (P1).**
   - Dialogs rise in over 180ms and vanish in one frame. Menus have no motion at
     all. There are three scrim recipes.
   - In light theme the dialog scrim *lightens* the page.
   - Nothing sets `transform-origin` at a trigger.
   → SYS-4, SYS-5, SYS-15.
8. **The accessibility media queries are missing or incomplete (P1).**
   - There are zero `prefers-contrast` and zero `prefers-reduced-transparency`
     rules.
   - In forced colours the wordmark disappears and all five statuses become
     identical hollow boxes.
   - The in-app "Reduce motion" setting doesn't reach framer's branches, the 3D
     scene or smooth scrolls.
   → SYS-11, SYS-12.
9. **Layouts break at phone width and touch targets are small (P1).**
   - The Services, Cluster and Audit tables clip columns at 390 with no edge cue.
   - The Flat map is 720px minimum.
   - Primary nav targets are 34px, and the time-range buttons are 23px, which
     fails even the brand's 24px floor.
   → SYS-14, SYS-18, CT-10.
10. **Confirmation weight is inverted (P1).**
    - Irreversible deletes (delete-job, delete-completed-pods, delete-pod) need one
      click. Reversible scale, set-image and rollback need the name typed.
    - Two destructive confirm buttons look identical to Cancel, and one of them uses
      a class (`.set-danger`) that no stylesheet defines.
    → CL-4, SYS-7.

**What is already good and must survive the fixes:**
- System font stacks.
- Tabular numerals.
- A visible `:focus-visible` ring on every tab stop.
- Entrance animations start from a visible resting state and never overshoot.
- The reduced-motion blocks never hide content.
- The Files `Resizer`: Pointer Events, `setPointerCapture`, grab offset kept, 1:1
  tracking, keyboard control. It is the model for any future drag UI.
- The Radix dialog trap.
- Honest empty and degraded copy.
- No horizontal page overflow at any width.
- The translucent sticky topbar, which meets R12.1.

---

## 3. Systemic fixes (do these first)

Each item names the area findings it absorbs. Severity is the highest of those.

### SYS-1 Add a press state: one shared `:active` rule - FIXED (batch 2)
- **Rule:** R1.1, R10.1. This also closes a gap against the brand's own
  `patterns/component-states.md` ("Active").
- **Severity:** P1. **Effort:** S.
- **Absorbs:** SY-4, SH-6, CT-6, FL-4, ST-8, CL-20 (press part).
- **Evidence:**
  - 2 `:active` rules in the app: `components/ServiceActions.css:96`
    (`.sa-verb`) and `pages/files/shell.css:234` (the splitter).
  - 123 `:hover` rules.
  - Under mouse-down, `.btn`, `.chip`, `.icon-btn`, `.nav-item`,
    `.svc-group-head`, `.set-opt` and `.fx-row` all compute the same style as on
    hover.
  - Screenshots: `S/shell/nav-pressed.png`, `S/shell/search-pressed.png`,
    `S/shell/range-pressed.png`, `S/cluster/s3-dark-pods-delete-pressed.png`.
- **Fix:**
  - New tokens in `index.css :root`: `--press-scale: .97`, `--press-scale-wide:
    .985`, `--press-dur: 100ms`, `--surface-press` (one step past `--surface-3`).
  - Compact controls: `:where(.btn,.chip,.icon-btn,.seg-toggle button,
    .topbar-search,.dlg-x,.svc-group-open,.svc-act-btn,.vit-ranges
    button):active:not(:disabled,[aria-disabled=true])` gets `scale:
    var(--press-scale)` with `transition-duration: var(--press-dur)`.
  - Row-shaped items get `background: var(--surface-press)` and no scale: nav,
    tabs, menu rows (`.tm-row`, `.um-item`, `.fx-menu-item`, `.cmdk-item`), `.fx-row`,
    `.rd-doc`, `.set-opt`, `.theme-card`, `.ct-item`.
  - Under reduced motion, drop the scale and keep the background.

### SYS-2 The focus rule re-rounds every control
- **Rule:** R16.7, R16.4.
- **Severity:** P1. **Effort:** S.
- **Absorbs:** SY-5.
- **Evidence:**
  - `index.css:1254` is `*:focus-visible { outline: 2px solid var(--accent);
    outline-offset: 2px; border-radius: 3px; }`.
  - On focus, 19 of 30 tab stops on Services change shape: `.tbl-wrap` 14→3px,
    `.topbar-search` and `.icon-btn` 10→3, `.chip` 8→3.
  - Files already works around it with four local rules (`pages/files/shell.css:
    90-96`).
  - Screenshot: `S/system/focus-topbar-search.png`.
- **Fix:** delete `border-radius: 3px` from that rule (an outline follows the
  element's own radius), then delete the Files workaround. Add tokens `--ring-w: 2px`
  and `--ring-offset: 2px`.

### SYS-3 Status tags use the fill token as text colour
- **Rule:** R16.7 (colour adapts to light and dark), WCAG 1.4.3.
- **Severity:** **P0**. **Effort:** S.
- **Absorbs:** CT-2, FL-6.
- **Evidence:**
  - `index.css:560` has `.tag.public { color: var(--st-up) }`, and `index.css:1104`
    has `.tag.ok, .tag.public { color: var(--st-up) }`.
  - In light theme that is `rgb(16,185,129)` on `#fafafa`: **2.43:1** at 11px/600.
  - Instances: 52 on Routes, 11 on Ports, and the Files Inspector "git"/"yes" tags
    at 9.5px.
  - `index.css:349` itself documents `--st-up` as "fill 2.50" and `--st-up-fg` as
    "fg 5.39".
  - Screenshots: `S/control/routes-1440-light.png`, `S/control/ports-390-light.png`,
    `S/files/edit-1440-light.png`.
- **Fix:**
  - `.tag.ok,.tag.public{color:var(--st-up-fg)}`, and the same for `.warn` →
    `--st-warn-fg` and `.down,.bad` → `--st-down-fg`.
  - Delete the first copy of each `.tag` rule (`index.css:558-563`).
  - Raise the Inspector tag to the scale's smallest step (11px).
  - Add a lint to `checks/theme-contract.mjs`: a `--st-*` fill token may never be a
    `color:`.

### SYS-4 Dialogs: keep them mounted, return focus, add a mirrored exit
- **Rule:** R16.10, R7.1, R7.3, R12.4.
- **Severity:** **P0**. **Effort:** M.
- **Absorbs:** CL-2, CT-5, SH-5, CT-12, CL-7, ST-10, and part of CL-3.
- **Evidence:**
  - Every consumer renders the dialog as `{open && <Dialog open …/>}`, so Radix
    unmounts it without running its close path, and focus lands on `<body>`:
    - `components/ServiceActions.tsx:114`
    - `pages/control/ClusterTabs.tsx:120,242,336,406,414,537`
    - `components/KubeActions.tsx:58,87,399`
    - `components/KubeConfirm.tsx:117`
    - `pages/Overview.tsx:570-574` (controlled, with no trigger)
  - The worst case: closing the nested delete-pod confirm puts focus outside the
    dialog that is still open.
  - `components/ui/Dialog.css:8,23` has enter keyframes only (`dlg-in` 180ms, 6px
    rise, scale .985). There is no `[data-state=closed]` rule anywhere. The settings
    drawer (`components/settings/settings.css:396`) enters with a slide and leaves
    instantly, and its 72% scrim pops in within one frame.
  - Screenshots: `S/cluster/s3-dark-dlg-pods-nested-delete.png`,
    `S/shell/system-dialog.png`, `S/settings/drawer-m-enter-60ms.png`.
- **Fix:**
  - Always render the dialog and drive it with `open={!!state}`.
  - Where the opener can unmount (row menus, poll re-renders), `Dialog` takes a
    `returnFocusTo` ref and calls it in `onCloseAutoFocus`.
  - Add `dlg-out` (120ms, `--ease-exit`, reverse of `dlg-in`) and `dlg-fade-out` to
    `Dialog.css`, and `set-drawer-out` to the drawer. Radix Presence waits for
    `animationend`.
  - Anchor tall dialogs at the top (`top:max(8vh,24px); translate:-50% 0`) so their
    header doesn't jump when the content changes height (CL-8).

### SYS-5 One popover/menu primitive
- **Rule:** R7.1, R7.2, R4.2, R16.4, R16.10.
- **Severity:** **P0** (it carries CL-1). **Effort:** M–L.
- **Absorbs:** SY-11, SH-12, FL-16, CL-1, CL-6.
- **Evidence:**
  - Nine hand-rolled surfaces: ThemeMenu, UserMenu, settings search, the Cluster
    row menu, the Files menu, the scope picker, the 3D tip, Tooltip and the command
    palette. They have 4 different offsets, 3 radii, 2 shadows, surfaces 1, 2 and 4,
    and z-index values of 20, 30, 40, 60 and 80. The table is in SY-11.
  - The only `transform-origin` in the codebase is the scroll rail.
  - The Cluster "…" menu is `position:absolute` inside a scrolling `.tbl-wrap`
    (`pages/control/cluster.css:71-78`), so it is clipped: a 2px sliver on the last
    row, and 1 of 4 items at 390. It declares `role=menu` but has no arrow keys and
    doesn't move focus.
  - `.fx-menu` and `.rd-scope-pop` sit on `--surface-1`, the same surface as the
    card beneath them.
  - Screenshots: `S/cluster/dlg-dark-menu-open-lastrow.png`,
    `S/cluster/m-390-dark-rowmenu.png`, `S/files/i-menu-open.png`.
- **Fix:**
  - Build `components/ui/Menu.tsx` and `Popover.tsx` on Radix DropdownMenu and
    Popover. Radix is already a dependency family through Dialog. They portal out of
    clipping ancestors and provide collision flipping and the keyboard model.
  - One CSS contract: `--surface-4`, `--line-strong`, `--r-lg`, `--shadow-3`, a 6px
    offset, rows 8/10px padding at `--fs-sm`, and one z-index token.
  - Motion: `transform-origin: var(--radix-popper-transform-origin)`. The enter is
    opacity 0→1 with scale .96→1 on `--spring` (critically damped, about 180ms
    perceived). The exit is 120ms of opacity with scale to .98.
  - Migrate the nine surfaces. The command palette moves onto `ui/Dialog` (that
    fixes SH-1).

### SYS-6 Hit targets: one token and a coarse-pointer block - FIXED (batch 2)
- **Rule:** R10.1, R16.5.
- **Severity:** P1. **Effort:** S–M.
- **Absorbs:** SY-19, SH-7, CT-9, CT-20, CL-15, FL-12, ST-9, and part of CT-18.
- **Evidence (measured at 390 touch):**
  - Nav items 34×34.
  - `.vit-ranges button` 23px tall (`components/Vitals.css:24-28`), which is below
    the brand's own 24px floor.
  - `.svc-act-btn` 26×26. Its cell swallows taps (`components/ServiceRow.tsx:52`
    `stopPropagation`), so the claimed hit padding is dead.
  - `.dlg-x` 28×28 (`components/ui/Dialog.css:40`).
  - `.fx-row` 22px tall (`pages/files/explorer.css:100`).
  - The per-folder download button is 16px and appears on hover only.
  - `.cl-small` buttons 29px tall.
  - Settings `.btn.sm` 30px tall, and copy buttons 26×24.
  - Only 3 declarations in the whole app sit under `(pointer: coarse)`.
- **Fix:**
  - Tokens `--hit: 2rem` and, under `@media (pointer: coarse)`, `--hit: 2.75rem`.
  - Apply them as `min-height`/`min-width` on `.btn`, `.chip`, `.icon-btn`,
    `.nav-item`, `.dlg-x`, menu rows and `.fx-row`.
  - Where the visual size must stay small (`.svc-act-btn`, `.ov-uirow-open`,
    `.set-cmd-copy`), use an invisible `::after{inset:-9px}` hit slop.
  - Show hover-only affordances when `(hover: none)`.

### SYS-7 Button primitive: disabled, danger, small, and tokenised transitions - FIXED (batch 2)
- **Rule:** R16.9, R16.3, R16.6, R16.4. Brand: `foundations/motion.md` (no literal
  durations).
- **Severity:** P1. **Effort:** S.
- **Absorbs:** SY-18, CL-11, CL-5, ST-4, ST-21, CL-20 (transition part), and the
  button part of SY-17.
- **Evidence:**
  - `.btn` (`index.css:1109-1114`) has no `:disabled` rule. Four disabled buttons
    render as live and still light up on hover: ThemeEditor Save
    (`pages/ThemeEditor.tsx:314`), Files Download (`pages/files/FileContent.tsx:151`),
    ConfigMap Save (`ClusterTabs.tsx:517`) and logs Follow (`KubeActions.tsx:551`).
  - The destructive confirms "Delete this pod" and "Yes, clear all N" compute the
    same as their Cancel buttons. `.set-danger` (`pages/settings/Data.tsx:173`) is
    defined in no stylesheet.
  - There are five `.btn.sm` variants (Services, Settings, Files, `.ka-small`,
    `.cl-small`).
  - `.btn{transition:border-color .15s, background .15s}` uses literal values and
    the default `ease`.
  - Screenshots: `S/cluster/s3-dark-config-edit-invalid.png`,
    `S/settings/data-clearall-confirm.png`,
    `S/cluster/dlg-dark-confirm-4-Delete_completed_pod.png`.
- **Fix:**
  - Disabled: `.btn:is(:disabled,[aria-disabled=true]){opacity:var(--disabled-opacity);cursor:not-allowed}`,
    with hover suppressed.
  - Danger: `.btn.danger{color:var(--st-down-fg);border-color:var(--st-down-line)}`,
    and on hover `background:var(--st-down-bg)`. It stays unfilled, which respects
    the brand's "don't make destructive the eye-catcher"
    (`components/ServiceActions.css:176-184`).
  - One `.btn.sm`.
  - Transitions: `var(--dur-fast) var(--ease)`.
  - Delete the 6 scoped disabled copies and `.te-danger`.

### SYS-8 Page transitions: stop waiting for the exit
- **Rule:** R1.2, R3.1, R14.1. **Conflicts with the brand** (§5).
- **Severity:** P1. **Effort:** S.
- **Absorbs:** SY-10, SH-9.
- **Evidence:**
  - `components/AppShell.tsx:183-211` uses `AnimatePresence mode="wait"` with 220ms
    literals, and `pages/control/ControlShell.tsx:151-162` nests a second one at
    180ms.
  - rAF sampling of Overview→Control: opacity reaches 0 by 251ms and is **still 0
    at 354ms**. The page is fully visible at 563ms.
  - Under OS reduced motion the page still fades out and in over about 440ms.
  - The brand token for this is `--dur-slow` 260ms, and it has zero uses.
- **Fix:** mount the new route immediately with a 120–180ms opacity-only enter,
  adding `y` only when motion is allowed. No exit, or an overlapping exit of 100ms or
  less (`mode="popLayout"`). Under reduce, no transition.

### SYS-9 Motion tokens in JS, and spring tokens - FIXED (batch 2)
- **Rule:** R4.1, R4.2, R7.3, R16.7. Brand: `motion.md`.
- **Severity:** P2. **Effort:** S–M.
- **Absorbs:** SY-9, CT-14, FL-20, SY-22, and the lerp part of CT-17.
- **Evidence:**
  - 37 literal CSS durations (`.16s` appears 17 times) and 25 bare `ease` keywords.
  - All 8 framer transitions are literals: 0.18, 0.22, 0.24, 0.3, 0.34 s. The curve
    `[0.2,0.7,0.2,1]` is pasted 5 times.
  - The five disclosure chevrons use four different timings.
  - `.ov-quick-item:hover{transition:.15s}` is declared only on hover, so the lift
    animates in and snaps out (`index.css:974`).
  - The 3D camera and slab animations use a per-frame `lerp(…, .08)`
    (`components/three/StackScene.tsx:190,705`), which runs at a different speed at
    each frame rate.
  - Nothing in the app is a spring.
- **Fix:**
  - New file `lib/motion.ts` exporting `DUR={fast:.12,base:.18,slow:.26,exit:.12}`,
    `EASE=[.2,.7,.2,1]`, `EASE_EXIT=[.4,0,.9,.4]`, and the spring presets from §6.
  - Replace every literal and use one `.chev` rule.
  - The 3D lerp becomes `1-Math.exp(-dt*ω)`, with ω≈18 for a 0.35 s response.

### SYS-10 Stop animating layout properties
- **Rule:** R11.1. Brand: `motion.md` says the same thing.
- **Severity:** P1. **Effort:** M.
- **Absorbs:** SY-8, SH-8, CT-13.
- **Evidence:**
  - Framer animates `height: 0↔auto` on every Services group collapse
    (`pages/Services.tsx:290-295`). Measured 95→64→28→17→0px over about 250ms,
    which forces layout on every frame for all the groups below it
    (`S/control/i-group-collapsing.png`).
  - Other layout transitions:
    - `.nav-label`: `max-width` and `margin-left` (`index.css:804`)
    - `.ct-nav`: `width` (`pages/control/control.css:89`)
    - `.ct-label`: `max-width` (`pages/control/control.css:148`)
    - `.skip-link`: `top` (`index.css:394`)
    - Topology SVG: `stroke-width` and `r` (`pages/Topology.css:70-92`)
  - The hover-expanding nav label pushes its neighbour about 60px sideways, under
    the pointer (`S/shell/820-nav-hover-expand.png`).
- **Fix:**
  - A `Disclosure` primitive using `grid-template-rows:0fr→1fr` plus an opacity
    fade, only under `prefers-reduced-motion: no-preference`.
  - Nav labels become an overlay label animating `opacity` and `translate`, so the
    row does not reflow.
  - `.ct-nav` uses `translate` or `clip-path: inset()`.
  - `.skip-link` uses `translate`.

### SYS-11 One reduced-motion source; stop the perpetual loops - PARTLY FIXED (batch 2)
- **Rule:** R14.1, R14.4, R16.4. Brand: `motion.md` invariant.
- **Severity:** P1. **Effort:** M.
- **Absorbs:** SY-13, ST-7, FL-13, CT-15, SH-11, and the loop part of CT-17.
- **Evidence:**
  - The in-app Settings "Reduce here" option reaches CSS (`prefs.css:19-25`) and
    framer's `MotionConfig` (`components/settings/PrefsRuntime.tsx:15`). It does not
    reach:
    - `useReducedMotion()` (OS only), which branches in AppShell:96,
      ControlShell:97, Services:43, ServiceDetail:26 and ProjectDetail:25;
    - the 3D scene (`components/three/webgl.ts:16`, read once), whose idle
      auto-orbit and cable pulses run at **0.26 Hz**, right in R14.4's band;
    - `scrollIntoView({behavior:'smooth'})` in `components/settings/SettingBlock.tsx:75`
      and `pages/files/Toc.tsx:164`, measured still animating under reduce.
  - Framer entrances start at `opacity:0` (`ServiceDetail.tsx:31-37,81`,
    `ProjectDetail.tsx:125-131,156`, `ControlShell.tsx:155`). That is the brand's
    forbidden Reveal pattern, and the stagger is unclamped.
  - The Live pulse beats forever at 0.5 Hz and animates `box-shadow`
    (`index.css:426-433`).
  - The OS reduce block lacks `animation-iteration-count:1`, which the in-app block
    has.
- **Fix:**
  - A `useMotionReduced()` hook that ORs the media query with
    `html[data-motion=reduce]` and subscribes to both. Use it everywhere, including
    `scrollBehavior()`.
  - Framer entrances animate `y` only, or start at `opacity:.001` via CSS. Clamp the
    stagger.
  - The Live pulse runs 3 iterations when the state changes, drawn as a `::after`
    that animates `scale` and `opacity`.
  - Stop the 3D idle orbit after the first interaction.

### SYS-12 Contrast, transparency and forced-colours media queries - FIXED (batch 2)
- **Rule:** R14.2, R14.3, R12.5.
- **Severity:** P1. **Effort:** S.
- **Absorbs:** SY-6, SY-7, SH-19, CT-22, CL-17, ST-20.
- **Evidence:**
  - Zero `prefers-contrast` and zero `prefers-reduced-transparency` rules in `src/`.
  - Six blurred surfaces: `.topbar`, `.cmdk-scrim`, `.dlg-overlay`, `.sv-frame`
    (a no-op blur on an opaque surface), `.sv-plate-txt` and `.sv-tip-card`.
  - Under `contrast: more`, `--line` stays at 10%.
  - Forced colours (`S/system/overview-1440-rm-forced-contrast.png`):
    - The wordmark vanishes. It is painted as `background:currentColor` through a
      mask (`index.css:730`).
    - Every `.sm-cell` and status segment becomes the same hollow box, so the
      forced-colours block's promised "filled vs hollow" never happens
      (`index.css:1281-1295`).
    - `.cl-dot` and `.ka-dot` are not listed in the block at all.
- **Fix:**
  - Material tokens: `--mat-chrome-bg`, `--mat-chrome-blur`, `--mat-scrim-bg`,
    `--mat-scrim-blur`.
  - `@media (prefers-reduced-transparency: reduce)`: solid chrome, no blur, and an
    88% scrim.
  - `@media (prefers-contrast: more)`: `--line` 28%, `--line-strong` 45%,
    `--fg-subtle: var(--fg-muted)`, and solid chrome, with light-theme values too.
  - Forced colours:
    - Wordmark: `.brand-wordmark::before,::after{forced-color-adjust:none;background:CanvasText}`.
    - Status marks: `forced-color-adjust:none`, with `CanvasText` fill for up, warn
      and down and `Canvas` for stopped and unknown. Only system colours are used.
    - Add `.cl-dot` and `.ka-dot` to the block.
  - Remove the `.sv-frame` blur.

### SYS-13 A closed type scale in rem, with size-specific tracking and leading - PARTLY FIXED (batch 2)
- **Rule:** R15.1–R15.5, R16.7. Brand: `foundations/typography.md` ("Close the type
  scale"), which it lists as its largest known gap.
- **Severity:** P1. **Effort:** L (mechanical once the tokens exist).
- **Absorbs:** SY-1, SY-2, SY-3, SH-15, FL-14, FL-15, CL-21, ST-13, CT-7.
- **Evidence:**
  - Of 503 `font-size` declarations, 481 are px, 3 are em and **0 are rem**.
  - With `html{font-size:125%}`, nothing measured changes except `.filter-search`
    (`font:inherit`, `index.css:896`), which grows and clips its placeholder at 390.
    Screenshots: `S/system/services-390-light-root125.png`,
    `S/system/overview-1440-dark-root125.png`.
  - There are **43 distinct sizes**, and 440 declarations fall in half-pixel steps
    between 9.5 and 13.5px.
  - Tracking: 69 literal `letter-spacing` values. The same 10.5px uppercase label
    uses .04, .05, .06, .07 and .08em in five files.
  - Files headings h1–h4 all use `-0.015em / 1.25` (`pages/files/editor.css:602`).
  - The global `h1{line-height:1.02}` is written for the 68px hero and also hits
    the 23–28px page titles.
  - `.svc-group-head` is a `<button>` with no `font:inherit`, so it renders in
    **Arial** (`index.css:906`, `S/control/services-1440-dark.png`).
  - Weights 550, 650 and 750 fall back to 600 or 700 on non-variable system fonts.
- **Fix:**
  - Add the 9-step rem scale in §6, with a paired line-height and tracking per step,
    and one `.eyebrow` class for uppercase micro-labels (`--label-tracking: .06em`).
  - Global `button,input,select,textarea{font:inherit}`.
  - Move the `h1` metrics onto `.hero h1`.
  - Express `--read-*` in rem.
  - Control padding in em, so it scales with the text.
  - Migrate the shell and Overview first, then each area.

### SYS-14 Elevation ladder and scrim token - FIXED (batch 2)
- **Rule:** R12.3, R12.4.
- **Severity:** P2. **Effort:** S.
- **Absorbs:** SY-12, CL-16.
- **Evidence:**
  - `--shadow-lg` covers 8 unrelated uses, from a card hover lift up to an 880px
    modal. `--shadow-sm` has 1 use.
  - Third-party themes change the shadow *geometry*, not only the colour
    (`themes/tokyo-night.css:145-147`).
  - In light theme `.dlg-overlay` is 72% of `--bg`, which is near-white, so the
    scrim lightens the page (`S/cluster/m-1440-light-dialog.png`).
- **Fix:**
  - Four steps with fixed meanings: `--shadow-1` rest, `-2` raised/hover,
    `-3` popover, `-4` modal/drawer/palette. The values are in §6.
  - Themes override only `--shadow-color` and `--shadow-hairline`.
  - A `--scrim` token: `rgb(9 9 11 / .38)` in light, `rgb(0 0 0 / .6)` in dark.

### SYS-15 Radii, spacing, icons and duplicated rules - PARTLY FIXED (batch 2)
- **Rule:** R16.7, R16.4.
- **Severity:** P2. **Effort:** M–L.
- **Absorbs:** SY-14, SY-15, SY-16, SY-17, CT-21.
- **Evidence:**
  - Radii: 88 literals. 43 of them equal an existing token, and 45 are off the
    ladder (13 of those are 8px).
  - `.chip` is declared twice with different radii, 999px at `index.css:886` and
    8px at `:1116`, and the later one wins.
  - Spacing: 44 distinct px values, only 35% on a 4px grid.
  - Icons: 253 lucide `size=` props in 14 sizes. The close `X` appears at 12, 13, 14
    and 16px, and `strokeWidth` is never scaled to size.
  - Duplicates: `.dot`, `.tag`, `.tbl`, `.chip`, `.badge`, `.ico` and `.btn.ghost`
    are each declared twice in `index.css`. 8 `.ov-*` selectors are duplicated in
    `pages/Overview.css`. 35 uppercase label rules.
  - Dead code: `.svc-card`, `@keyframes bob`, `--hover-opacity`, `--track`.
  - `--border-w` has 2 uses against about 250 `1px` literals.
- **Fix:**
  - Swap the exact radius matches to tokens mechanically, and fold 8px into
    `--r-sm` or `--r-md`.
  - Add the spacing scale in §6.
  - Icon tokens `--icon-xs 12 / sm 14 / md 16 / lg 20`, via a thin `<Icon>` wrapper
    that uses `absoluteStrokeWidth`.
  - Delete the first copy of each duplicate and the dead rules.

### SYS-16 Sticky chrome: a scroll-edge shade instead of a hairline
- **Rule:** R12.6, R12.1.
- **Severity:** P2. **Effort:** S.
- **Absorbs:** SY-20, and part of ST-6 and CL-14.
- **Evidence:**
  - These sticky elements carry a permanent 1px `--line` bottom border: `.topbar`
    (`index.css:657-659`), sticky `.tbl th`, `.set-mobile-bar`
    (`components/settings/settings.css:417`) and `.rd-index-h` / `.rd-root-h`.
  - The app already has the right mechanism: `.scroll-shade` with
    `data-shade-*`, driven by `lib/scroll.ts`. The page-level chrome just doesn't
    use it.
  - `.cl-tbl` lacks `scroll-shade`, so at 390 its off-screen action column has no
    cue.
- **Fix:**
  - A `data-scrolled` attribute on `.topbar` (lib/scroll.ts already tracks page
    scroll), showing a soft bottom shade only once scrolled.
  - Add `scroll-shade` to every `.tbl-wrap`.
  - Expose a `--topbar-h` token so the Settings mobile bar stacks under the topbar
    instead of covering it (ST-6).

### SYS-17 Narrow tables become cards
- **Rule:** R16.5, R16.7, R16.10.
- **Severity:** P1. **Effort:** M.
- **Absorbs:** CT-8, CL-14, ST-5.
- **Evidence:**
  - Services at 390 has 7 columns per group, and Status, Group and Kind are clipped
    (`S/control/services-390-dark.png`).
  - Cluster Pods at 390 puts Logs and Delete off-screen
    (`S/cluster/m-390-dark-pods.png`).
  - Audit at 390 puts a 647px table in a 330px scroller. The Detail column is 68px,
    rows are up to 152px tall, and emails break mid-token
    (`S/settings/audit-m-dark-full.png`).
  - Settings › Updates already switches to labelled cards at 640px or below
    (`components/settings/settings.css:354-369`).
- **Fix:**
  - Promote the Updates pattern to a shared `.tbl.as-cards` rule at 640px or below,
    using `td[data-label]`, and apply it to ServiceTable, the Cluster tables, Audit,
    Users, Credentials and Backups.
  - Services passes `showGroup={false}`, since the group is already the panel
    heading.
  - Use `table-layout:fixed` plus a `<colgroup>`, so stacked service tables line up
    (CT-16).

### SYS-18 Shared state components: loading is not "not found"
- **Rule:** R16.9, R16.10.
- **Severity:** P1. **Effort:** S.
- **Absorbs:** CT-4, SH-16, SH-17, ST-18, ST-17, and the shared part of FL-17.
- **Evidence:**
  - On a cold load, real service and system pages say "Service not found" or "No
    such system" for 3–4 s (`pages/ServiceDetail.tsx:39`,
    `pages/ProjectDetail.tsx:~138`). `pages/control/Control.tsx` already has the
    right test.
  - Skeletons are `aria-hidden`, and there is no `aria-busy` or `role=status`
    (`components/states.tsx:55-64`).
  - The 404 and the unknown settings section have no h1 and don't change the
    document title (`App.tsx:106-118`, `pages/settings/routes.tsx:44-51`).
  - The theme editor's error state has no way back.
  - "Retry" is offered for a 404, where it cannot help.
- **Fix:**
  - A `useLoaded()` helper (`data.at===0 && data.fails===0` → Skeleton).
  - `aria-busy` and an sr-only live "Loading…".
  - `ErrState` gains `actions` and `title` props.
  - One `NotFound` component with an `<h1>`, `document.title`, and the requested
    value shown in mono. Use it for routes, settings sections, the theme editor and
    files.

### SYS-19 Theme: follow the OS, and ease the switch
- **Rule:** R16.5, R16.7, R14.4. **Conflicts with the brand** (§5).
- **Severity:** P2. **Effort:** S.
- **Absorbs:** SH-18, SH-10.
- **Evidence:**
  - `lib/themes.ts:102` sets `DEFAULT_SELECTION='bothy-dark'`, so a light-OS first
    visit gets dark.
  - A theme switch changes the body background from `rgb(9,9,11)` to white in one
    frame (`S/shell/theme-switched-light.png`).
- **Fix:**
  - Default to `'system'`, and update the pre-paint script in `index.html` and its
    CSP hash.
  - Wrap `apply()` in `document.startViewTransition?.()` with a 200ms root
    cross-fade, skipped under reduce.

### SYS-20 The token docs have drifted - FIXED (batch 2)
- **Rule:** brand `quality/governance.md`.
- **Severity:** P2. **Effort:** S.
- **Absorbs:** SY-21.
- **Evidence:**
  - `docs/brand/reference/tokens.md` lists 6 chrome accents. The code has 5, with
    different values (`index.css:143-147`).
  - Light `--bg-glow` is a blue `#dfe5f5`, but the doc says "#ffffff-adjacent".
  - Undocumented tokens: `--rest-opacity`, `--read-*` and `--font-serif`.
  - `typography.md` says 17 font sizes; the code has 43. `shape-and-elevation.md`
    says 2 blurs; the code has 6. `space-and-layout.md` says 7 z-index values; the
    code has 14.
- **Fix:** generate `tokens.md` from `index.css` with a script, and delete or adopt
  the dead tokens.

---

## 4. Page-specific findings

These are the findings not absorbed above. Each keeps its area ID so it can be traced
back to the probe data in `work/<area>/`.

### 4.1 Shell and Overview (SH)

**SH-1 The command palette lets Tab escape, and then Escape stops working**
- **Rule:** R16.10, R12.4. **Severity:** **P0**. **Effort:** S.
- **Evidence:** `S/shell/palette-tab-escaped.png`. The `onKey` handler sits on the
  `<input>` only (`components/CommandPalette.tsx:123-131`). The palette has no Tab
  handling, and the window handler in `AppShell.tsx:59-94` doesn't handle Escape.
- **Fix:** move the palette onto `ui/Dialog` (SYS-5). In the meantime, contain Tab
  and handle Escape on `.cmdk-scrim`.

**SH-2 The active-page underline is clipped**
- **Rule:** R16.10. **Severity:** P1. **Effort:** S.
- **Evidence:** `S/shell/nav-active-1440.png`, `nav-active-390.png`.
  `.nav-item.on::after` sits at `bottom:-11px` (`index.css:797`), but `.nav` has
  `overflow-y:hidden` with 2px padding (`:776,:781`). In icon-only mode, "you are
  here" is only an icon opacity change from .85 to 1.
- **Fix:** draw the bar at `bottom:0`, and add a `.nav-item.on` background at 1080px
  and below.

**SH-3 The offline state contradicts itself**
- **Rule:** R16.9, R16.3. **Severity:** P1. **Effort:** S.
- **Evidence:** `S/shell/state-error.png`.
  - The heading is left-aligned while its paragraph is centred (`index.css:978`
    against `:573`).
  - "All 0 services that report in are up", with a green check, because
    `allVerifiedUp` is true when `verified=0` (`pages/Overview.tsx:185-201`).
  - There is no Retry button.
  - The meters draw a dot for a "-" value.
- **Fix:** never show the up-check when `verified===0`. Render `ErrState
  onRetry={refresh}`. Set `margin-left:0` on the paragraph. Hide the meter fill when
  the value is null.

**SH-4 The Live/stale/offline pill is hidden at 900px and below**
- **Rule:** R16.9. **Severity:** P1. **Effort:** S.
- **Evidence:** `.topbar-pill{display:none}` (`index.css:846`). Phone and tablet
  users cannot tell that the data is stale.
- **Fix:** keep the dot as a 10px glyph with an `aria-label`, and hide only the
  text.

**SH-13 Palette results duplicate and over-match**
- **Rule:** R16.12, R16.6. **Severity:** P2. **Effort:** M.
- **Evidence:** `S/shell/palette-query-arrow.png`. The query "graf" returns four
  rows labelled "Grafana" plus Loki, Alloy and others, because the substring match
  includes the subtitle (`CommandPalette.tsx:88-92`). The selected row is
  `--surface-3` on `--surface-4`, about 1.1:1 (`index.css:1170`).
- **Fix:** rank results (exact, prefix, word, label substring, then sub).
  Disambiguate duplicate labels. Mark the selection with `--accent-bg` and a 2px left
  bar.

**SH-14 TimeChart y-labels overflow the panel, and touch gets no readout**
- **Rule:** R16.7, R16.5, R1.3. **Severity:** P2. **Effort:** S.
- **Evidence:** `S/shell/overview-1440-dark-full.png` (Ethernet panel). `PAD.left=40`
  is fixed (`components/TimeChart.tsx:43,137`). The readout is driven by pointermove
  only (`:117-122`), and `S/shell/390-chart-tap.png` shows a tap doing nothing.
- **Fix:** measure the tick label width. On a `pointerdown` from touch, pin
  `hoverX`. Add keyboard scrubbing.

**SH-17 The 404 and unknown section have no h1 or title**
- Covered by SYS-18.

**SH-20 Live data re-sorts the system matrix under the pointer**
- **Rule:** R16.4, R3.1. **Severity:** P2. **Effort:** M.
- **Evidence:** in `S/shell/user-menu-open.png` against
  `S/shell/timechart-hover-edge.png`, "Thales" moves from 2nd to 11th between polls
  (`components/SystemMatrix.tsx`).
- **Fix:** freeze the order while the pointer or focus is inside `.sm`, or animate
  the reorder with FLIP (framer `layout`).

**SH-21 QuickView leaves an orphan tile at 390 and 820**
- **Rule:** R16.7. **Severity:** P2. **Effort:** S.
- **Evidence:** `S/shell/overview-390-light.png`. Uptime sits alone in its row
  (`components/QuickView.css:72-73`).
- **Fix:** a 6-column grid with spans of 3/3/2/2/2.

**SH-22 The panel footer "·" separators measure 1.69:1**
- **Rule:** R16.7. **Severity:** P2. **Effort:** S.
- **Evidence:** `pages/Overview.css:176`. The separator is decorative.
- **Fix:** add `aria-hidden`, or use `--fg-subtle`.

### 4.2 Control: Services, Ports, Routes, Topology, detail pages (CT)

**CT-1 The sortable headers on Ports and Routes cannot be reached by keyboard**
- **Rule:** R16.5, R16.10. **Severity:** **P0**. **Effort:** S.
- **Evidence:** `S/control/i-ports-thhover.png`. The headers are bare `<th onClick>`
  with tabIndex -1 (`components/PortsTab.tsx:148-156`,
  `components/RoutesTab.tsx:175-183`).
- **Fix:** a shared `SortHeader` component: a `<button>` inside the `<th>`, with
  `aria-sort` kept on the `<th>`.

**CT-3 Zero-count filter chips are live controls drawn at 1.9–2.4:1**
- **Rule:** R16.6, WCAG 1.4.3. **Severity:** **P0**. **Effort:** S.
- **Evidence:** `S/control/services-1440-light.png`. `.chip.is-zero{opacity:.45}`
  (`pages/Services.css:26`, duplicated in `pages/Detail.css`).
- **Fix:** drop the opacity. Keep the label at `--fg-muted` and set the count to
  `--fg-subtle`. If zero really means the filter can't be used, mark the chip
  `aria-disabled`.

**CT-10 The Flat map is unusable at phone width**
- **Rule:** R16.5, R16.10. **Severity:** P1. **Effort:** M.
- **Evidence:** `S/control/topo-flat-390-dark.png`. `.topo-svg{min-width:720px}`
  (`index.css:1037`), so the map opens on the empty EDGE column. The subtitle says
  "hover", which touch cannot do. The hub is drawn at `height/2`, below the fold.
- **Fix:** below 640px, render a list with dependency chips. Word the hint by input
  type. Pin the hub to `min(h/2,240)`.

**CT-11 The default 3D framing makes labels about 4–5px**
- **Rule:** R16.6. **Severity:** P1. **Effort:** M.
- **Evidence:** `S/control/topo-3d-1440-dark.png`. The presets are in
  `components/three/StackScene.tsx` (around line 800).
- **Fix:** drei `<Bounds fit clip observe>`, and clamp the `<Html>` plates to a
  minimum screen size.

**CT-16 Stacked service tables don't share column positions**
- **Rule:** R16.7. **Severity:** P2. **Effort:** S.
- **Evidence:** `S/control/services-1440-dark.png`. The Status column starts at
  x≈550, 517 and 578 in consecutive groups. `components/ServiceTable.tsx:9-11` claims
  a fixed template, but none exists.
- **Fix:** covered by SYS-17 (`table-layout:fixed` plus a `<colgroup>`).

**CT-17 The 3D scene stops hard at its limits and has no keyboard path**
- **Rule:** R9, R16.5. **Severity:** P2. **Effort:** M.
- **Evidence:** `StackScene.tsx:730-735` clamps zoom and polar angle with no give
  (`S/control/topo-3d-zoomin-max.png`). The slabs are pointer-only. The orbit itself
  passes: it is 1:1, interruptible, and damped on release.
- **Fix:** a soft limit on distance (rubber-band within the last 10%), and a
  focusable DOM overlay list of slabs, or link to the Flat map as the keyboard route.

**CT-18 On touch the 3D viewport gives no gesture hint and takes most of the screen**
- **Rule:** R10.3, R16.10. **Severity:** P2. **Effort:** S.
- **Evidence:** `S/control/topo-3d-390-dark.png`. The canvas is 577 of 844px tall,
  and `.sv-hint` is `display:none` below 640px (`components/three/three.css:264`).
- **Fix:** under `(pointer:coarse)`, show a one-line hint and cap the canvas at about
  55svh.

**CT-19 The static rack uses dark-theme status hexes in both themes**
- **Rule:** R16.7. **Severity:** P2. **Effort:** S.
- **Evidence:** `components/three/StaticStack.tsx:29,53` reads `STATUS_HEX`
  (`components/three/webgl.ts`).
- **Fix:** `--led: var(--st-*)`, the way `Topology.tsx` already does it. Drop the
  hover translate.

**CT-20 LogPanel search applies on Enter only, with no hint**
- **Rule:** R16.9. **Severity:** P2. **Effort:** S.
- **Evidence:** `components/LogPanel.tsx` (`submit`). The radius literals are at
  `LogPanel.css:19,33,47`.
- **Fix:** apply the search on a debounce, or show a ↵ affordance. Use the radius
  tokens.

### 4.3 Cluster and the kube dialogs (CL)

CL-1 and CL-6 are covered by SYS-5. CL-2 and CL-7 are covered by SYS-4. CL-5 and
CL-11 are covered by SYS-7. CL-14 and CL-15 are covered by SYS-17 and SYS-6. CL-16 is
covered by SYS-14, CL-17 by SYS-12, and CL-21 by SYS-13.

**CL-3 The delete-pod confirm opens a second modal on top of the first**
- **Rule:** R12.4, R16.4. Brand `patterns/feedback.md`: "one dialog at a time".
- **Severity:** P1. **Effort:** S.
- **Evidence:** `S/cluster/s3-dark-dlg-pods-nested-delete.png` (two scrims).
  `components/KubeActions.tsx:399-407`.
- **Fix:** use the inline `ConfirmPanel`, the way HistoryTab does
  (`KubeActions.tsx:301-314`).

**CL-4 Confirmation weight is inverted against reversibility**
- **Rule:** R16.2, R16.3. Brand `patterns/forms.md:36`.
- **Severity:** P1. **Effort:** S for the catalog change, M for undo.
- **Evidence:** the live `/-/api/kube/catalog`. Delete-job, delete-completed-pods
  and delete-pod need one **click**. Scale, set-image and rollback need the name
  **typed**. Pause and resume still confirm. The UI mirrors the catalog in
  `KubeConfirm.tsx:95-103`.
- **Fix:** in the bothy-ops catalog:
  - delete-job and delete-completed-pods become `type-name`;
  - pause and resume become `none`, with an inline Resume/Undo;
  - scale to 1 or more becomes `click`, and scale to 0 stays `type-name`.

**CL-8 The dialog jumps vertically when its content changes**
- **Rule:** R7, R16.7. **Severity:** P2. **Effort:** S.
- **Evidence:** the header top sits at 155, 230, 183 and 304px across the same
  dialog's states (`components/ui/Dialog.css:11-13`, which centres at 50%).
- **Fix:** top-anchor it (SYS-4).

**CL-9 The Scale input clamps on every keystroke and defaults to 1**
- **Rule:** R16.9, R16.3. **Severity:** P1. **Effort:** S.
- **Evidence:** clearing the field makes it 0, and the banner flips to "stops
  entirely". Typing 7 becomes 3 (`KubeActions.tsx:170`). The default is
  `useState(1)` (`:133`), not the current replica count. Screenshot:
  `S/cluster/m-390-light-dialog-scale.png`.
- **Fix:** keep a raw string while typing, show an inline range message, and clamp
  on blur. Initialise from `status.data.replicas`. Disable submit when the value
  equals the current count.

**CL-10 A typed-name mismatch only reddens the border**
- **Rule:** R16.9. **Severity:** P2. **Effort:** S.
- **Evidence:** `S/cluster/dlg-dark-confirm-scale-wrongname.png`
  (`KubeActions.css:40`). The focus ring hides the red border.
- **Fix:** an inline "Doesn't match {name}" message linked with
  `aria-describedby`.

**CL-12 ConfigMap inline edit ignores Escape and loses focus on Cancel**
- **Rule:** R16.10. **Severity:** P2. **Effort:** S.
- **Evidence:** `ClusterTabs.tsx:511-526`. The row also grows from 32 to 66px.
- **Fix:** Escape cancels and focus returns to the row's Edit button. Keep the
  editor on one line at 760px and above.

**CL-13 Logs show raw ANSI escapes**
- **Rule:** R16.7. **Severity:** P1. **Effort:** S.
- **Evidence:** `S/cluster/s3-dark-dlg-logs.png` shows `␛[32m200␛[0m`
  (`KubeActions.tsx:564-566`, `ClusterTabs.tsx:462`).
- **Fix:** strip `/\x1b\[[0-9;]*m/g` in `lib/kube-actions.ts`, or map SGR codes to
  `--st-*` colours. Check LogPanel for the same problem.

**CL-18 Duplicate IDs between page tabs and dialog tabs**
- **Rule:** R16.4. **Severity:** P2. **Effort:** S.
- **Evidence:** `components/Tabs.tsx:50-52` hard-codes `tab-${key}`.
- **Fix:** use `useId()` or an `idPrefix` prop.

**CL-19 Every namespace radio is its own tab stop**
- **Rule:** R16.4. **Severity:** P2. **Effort:** S.
- **Evidence:** `pages/control/Cluster.tsx:72-80`.
- **Fix:** roving tabindex with arrow keys, the way `Tabs` does it.

**CL-22 The Metrics tab has no Refresh button**
- **Rule:** R16.4. **Severity:** P2. **Effort:** S.
- **Evidence:** `ClusterTabs.tsx:736-738`.
- **Fix:** use `ReadHead` with a `reload`.

**CL-23 Clickable deployment cards look the same as inert ones**
- **Rule:** R16.4, R16.6. **Severity:** P2. **Effort:** S.
- **Evidence:** `S/cluster/1440-dark-topology.png` (`cluster.css:98-106`).
- **Fix:** a trailing chevron and a `:active` state.

**CL-24 The dialog's tabs wrap at 390**
- **Rule:** R16.7. **Severity:** P2. **Effort:** S.
- **Evidence:** `S/cluster/m-390-light-dialog-scale.png`.
- **Fix:** promote the `.cl-tabs` scroll-shade strip (`cluster.css:18-19`) into
  `Tabs`.

**CL-25 Unknown `?tab=` and `?ns=` values fall back silently**
- **Rule:** R16.10. **Severity:** P2. **Effort:** S.
- **Evidence:** `Cluster.tsx:50-53`.
- **Fix:** `replace` the URL with the resolved values, and show a note when the
  namespace was not found.

### 4.4 Files: reader, guide, explorer, editor (FL)

**FL-1 Hard-wrapped list items break after their first source line**
- **Rule:** R16.7, R15.3. **Severity:** P1. **Effort:** S.
- **Evidence:** `S/files/doc-1440-light.png`, `S/files/doc-390-dark.png`. In
  `pages/files/md.tsx:486-504`, continuation lines become a nested block. This
  affects almost every list in `docs/` and the notes.
- **Fix:** join continuation lines to the item's text. Start a `sub` block only at a
  blank line or a deeper list marker.

**FL-2 Escape cannot close the scope picker**
- **Rule:** R16.10. **Severity:** P1. **Effort:** S.
- **Evidence:** `S/files/i-scope-open.png`. The input stops propagation of Escape
  (`pages/files/ScopePicker.tsx:163-166`, against `:85-88`).
- **Fix:** close on Escape in the input and return focus to the trigger.

**FL-3 A deep link without `?root=` silently drops the path**
- **Rule:** R16.10, R16.9. **Severity:** P1. **Effort:** S.
- **Evidence:** `S/files/missing2-1440-light.png` (`pages/files/Reader.tsx:221-224`).
- **Fix:** keep `path` when defaulting the root.

**FL-5 The reading measure is uncapped: about 97 characters at 1440**
- **Rule:** R15. Brand `typography.md` ("about 90ch"). **Severity:** P1.
  **Effort:** S.
- **Evidence:** `--read-measure:100%` (`index.css:192`, applied at
  `pages/files/editor.css:591`). See `S/files/guide-1440-dark.png`.
- **Fix:** `--read-measure:75ch` applied to `.fx-read > *` with
  `margin-inline:auto`. The scroller stays full width, which also dissolves the
  scrollbar objection recorded at `index.css:182-185`.

**FL-7 Gutter line numbers measure 3.19:1**
- **Rule:** WCAG 1.4.3. **Severity:** P2. **Effort:** S.
- **Evidence:** `pages/files/editor.css:407` (`opacity:.65`).
- **Fix:** `color:var(--fg-subtle)` with no opacity.

**FL-8 The splitter stops hard at its minimum**
- **Rule:** R9, R8. **Severity:** P2. **Effort:** M.
- **Evidence:** `S/files/i-sep-pastmin.png` (`pages/files/panes.ts:32-35,86-89`,
  `Resizer.tsx:59-62`).
- **Fix:** rubber-band past the limits (about 30px at most). On release below
  0.6×min, collapse; otherwise spring back to min with response 0.3.

**FL-9 A splitter click moves the rail (no hysteresis)**
- **Rule:** R10.2. **Severity:** P2. **Effort:** S.
- **Evidence:** a 3px wobble resized the rail from 180 to 183px
  (`Resizer.tsx:52-56`).
- **Fix:** a threshold of 4px for mouse and 10px for touch, then rebase so the rail
  doesn't jump by the threshold.

**FL-10 A splitter drag re-renders the whole IDE on every move**
- **Rule:** R1.3, R11.1. **Severity:** P2. **Effort:** M.
- **Evidence:** 405 DOM mutations over 40 moves, and long tasks of 60–83ms
  (`panes.ts:132-134`). Nothing below `Files.tsx` is memoised, despite comments
  saying nothing re-renders.
- **Fix:** write the CSS variable directly during the gesture and commit on
  pointerup, or memoise the panes.

**FL-11 Tree indent guides stop at depth 3**
- **Rule:** R16.7. **Severity:** P2. **Effort:** S.
- **Evidence:** `pages/files/explorer.css:83-94`.
- **Fix:** `--depth` on each `<ul>` and `calc()`.

**FL-17 Missing-file states offer only Retry, and the status bar says "opening…"
forever**
- **Rule:** R16.9, R16.10. **Severity:** P2. **Effort:** S.
- **Evidence:** `pages/files/FileView.tsx:131-153`, `Editor.tsx:1023`.
- **Fix:** see SYS-18. Offer "Back to Start" and "Search for X", and use the same
  wording in the reader and the editor.

**FL-18 The reader search's "every root" select is clipped**
- **Rule:** R16.7. **Severity:** P2. **Effort:** S.
- **Evidence:** `S/files/i-reader-searchrow.png` (`pages/files/search.css:30-35`).
- **Fix:** `flex:none` and a chevron indicator.

**FL-19 Tab drag-to-split: the drop hint pops**
- **Rule:** R8. **Severity:** P2. **Effort:** S.
- **Evidence:** `editor.css:118-128`. Native DnD is proportionate here, and "Open in
  a split" exists as the non-drag path.
- **Fix:** fade in the drop edge with a slight translate in its direction.

**FL-21 The Files menu cycles Tab instead of closing**
- **Rule:** R16.10, the APG menu pattern. **Severity:** P2. **Effort:** S.
- **Evidence:** `pages/files/Menu.tsx:108-110`.
- **Fix:** Tab closes the menu. This is solved by SYS-5.

### 4.5 Settings and the theme editor (ST)

**ST-1 The theme editor keeps the previous draft when the route id changes**
- **Rule:** R16.3, R16.10. **Severity:** P1. **Effort:** S.
- **Evidence:** `S/settings/theme-unknown-after-new-d-dark.png` shows "Editing
  does-not-exist" with Save and Delete live. The load effect never resets the draft
  (`pages/ThemeEditor.tsx:121-148`).
- **Fix:** key the route element by id, or reset the draft at the start of the
  effect and in its `catch`.

**ST-2 The theme editor discards a palette on navigation without warning**
- **Rule:** R16.2. **Severity:** P1. **Effort:** M.
- **Evidence:** `pages/ThemeEditor.tsx:169-173,285`.
- **Fix:** keep the draft in sessionStorage keyed by route id and restore it (undo
  rather than a confirm).

**ST-3 Theme editor panels have a 0px gap and UA h2 margins**
- **Rule:** R16.7. **Severity:** P1. **Effort:** S.
- **Evidence:** `S/settings/theme-new-d-dark-full.png`. `.theme-editor` is
  `display:block`, and `.panel-h` keeps the UA margin (`index.css:1073-1078`).
- **Fix:** `.theme-editor{display:flex;flex-direction:column;gap:14px}` and
  `.panel-h{margin:0}` globally.

**ST-6 On phones the sticky Sections bar covers the global topbar**
- **Rule:** R16.10. **Severity:** P1. **Effort:** S.
- **Evidence:** `S/settings/appearance-m-scrolled.png`
  (`components/settings/settings.css:415-419`).
- **Fix:** `top:var(--topbar-h)` (SYS-16).

**ST-11 Reduced motion removes fades as well as slides**
- **Rule:** R14.1. **Severity:** P2. **Effort:** M.
- **Evidence:** `prefs.css:19-25` and `index.css:1297-1301` zero every duration.
- **Fix:** see the conflict in §5. Collapse transforms, and keep opacity and colour
  at `--dur-fast`.

**ST-12 Spacing rhythm is uneven inside blocks**
- **Rule:** R16.7. **Severity:** P2. **Effort:** S.
- **Evidence:** `S/settings/appearance-d-dark-full.png`. Legacy margins stack on top
  of the block gap: `pages/Settings.css:44,132-136,247`. `.set-note` is defined twice
  (`Settings.css:50`, `settings.css:162`).
- **Fix:** delete the legacy margins and keep one `.set-note`.

**ST-14 The theme name is validated only after Save**
- **Rule:** R16.9. **Severity:** P2. **Effort:** S.
- **Evidence:** `pages/ThemeEditor.tsx:204`.
- **Fix:** validate inline on blur with `aria-invalid`, and focus the field when a
  save fails.

**ST-15 Theme delete uses a native `confirm()` for a recoverable action**
- **Rule:** R16.2, R12.4. **Severity:** P2. **Effort:** M.
- **Evidence:** `pages/ThemeEditor.tsx:246-251`.
- **Fix:** delete, then show "Deleted X — Undo" for about 10 s.

**ST-16 Theme picker: a link nested in a button, visible on hover only, and 7 tab
stops**
- **Rule:** R16.5, R16.4. **Severity:** P2. **Effort:** S.
- **Evidence:** `pages/settings/Appearance.tsx:45-82`, `pages/Settings.css:184-194`.
- **Fix:** roving tabindex, with Edit as a sibling that is always visible when
  `(hover:none)`.

**ST-19 The Audit page repeats its title, shows relative times only, and wraps its
filters awkwardly**
- **Rule:** R16.1, R16.6. **Severity:** P2. **Effort:** S.
- **Evidence:** `S/settings/audit-d-dark.png`. "Audit log" appears 4 times at 390.
  The absolute time exists only in a `title` (`components/settings/bits.tsx:44-49`).
- **Fix:** a bare SettingBlock variant, an absolute `HH:MM:SS` with the relative
  time as a sub-line, and a single filter row.

---

## 5. Conflicts between the skill and docs/brand

These were recorded here unresolved. **All ten were decided on 2026-09-21** - see
"Decisions (approved 2026-09-21)" right after this section, which supersedes the
"Proposal" lines below.

1. **One easing curve vs springs and mirrored easing.**
   - Brand (`foundations/motion.md`, `tokens.md`): three durations and **one**
     easing for everything.
   - Skill (R4, R7.3): springs for anything touchable, mirrored easing on reversible
     transitions.
   - The brand curve `cubic-bezier(.2,.7,.2,1)` is an ease-out. It suits entrances,
     but exits then leave at full speed and brake, which reads as sluggish.
   - **Proposal:** keep `--ease` for enter and settle. Add `--ease-exit` and a
     `--spring` `linear()` token for overlays and disclosure (§6). Record it in
     `reference/decisions.md`.
2. **Waiting for the page exit vs latency.**
   - Brand (`motion.md`): "the outgoing page finishing before the next mounts".
   - Skill (R1.2, R3.1): no inessential latency, never lock input.
   - The measured cost is about 560ms per navigation, with about 130ms of blank
     frames (SYS-8). **Proposal:** the skill wins here. Accessibility-adjacent
     latency outranks aesthetics under the brand's own precedence list.
3. **How much reduced motion removes.**
   - Brand: "collapses duration; it never hides", implemented as `.01ms` on
     everything.
   - Skill (R14.1): keep short cross-fades and the opacity and colour changes that
     aid comprehension.
   - Both agree that nothing is hidden. **Proposal:** collapse transforms, and keep
     opacity and colour at `--dur-fast`.
4. **Opaque surfaces vs translucent materials.**
   - Brand (`shape-and-elevation.md`, `colour.md`): surfaces are opaque, and blur is
     allowed only on the topbar and the palette scrim. The reason is that
     translucency over a tinted backdrop broke the elevation ladder.
   - Skill (R12.1–R12.3, R12.7): translucent layered chrome that materialises.
   - The topbar already satisfies R12.1. **Proposal:** keep cards opaque, and
     accept this as a deliberate divergence. Fix the doc, which says 2 blurs where
     there are 6 (the dialog overlay's blur is undocumented).
5. **Dark by default vs following the OS.**
   - Brand (`theming.md:44`): dark is the default.
   - Skill (R16.5, R16.7): adapt to the device.
   - SYS-19 proposes `system` as the default. This needs sign-off.
6. **Touch-target floor.**
   - Brand (`quality/responsive.md:22`): 24×24, with 44 only for "frequent or
     primary" actions.
   - Skill (R10.1): about 44 plus hit padding.
   - The primary nav at 34px misses even the brand's own primary rule.
     **Proposal:** 44 under `(pointer:coarse)` via `--hit` (SYS-6), and leave
     fine-pointer sizes alone.
7. **Confirmation policy.**
   - Brand (`forms.md:36`, `feedback.md`): typed confirmation **or** an undo window
     for destructive actions, and a named confirm is acceptable.
   - Skill (R16.2): confirm only the irreversible, and use undo for the rest.
   - The catalog violates both, in opposite directions (CL-4). Theme delete is
     recoverable but confirms (ST-15).
   - **Proposal:** adopt "irreversible → typed name; reversible → act, then offer
     undo".
8. **Three shadow steps vs "bigger surfaces read thicker".**
   - Brand: three steps.
   - Skill (R12.3): larger surfaces cast deeper shadows.
   - **Proposal:** a fourth, modal step (SYS-14).
9. **Destructive button weight.**
   - `ServiceActions.css:176-184` deliberately avoids a strong destructive fill.
   - Skill (R16.3, R16.6): the consequence should look distinct.
   - SYS-7's unfilled `--st-down` outline meets both.
10. **The sidebar and the drawer.** These are internal tensions in the brand itself
    (`space-and-layout.md` calls a sidebar a dead end, and `decisions.md` records
    Control and Settings as exceptions). The skill supports persistent section
    navigation (R16.10). It only asks that the drawer's exit mirror its entrance
    (SYS-4).

The two sides already agree on: the system font, no overshoot on entrances, never
hiding content under reduced motion, a required "Active" press state (a compliance
gap, not a conflict), and validating inline rather than on submit.

---

## Decisions (approved 2026-09-21)

The owner approved these on 2026-09-21. They resolve every conflict in §5, and they
supersede the "Proposal" lines there. The brand docs carry the same rules with a
dated note where a rule changed (`foundations/motion.md`, `foundations/theming.md`,
`foundations/shape-and-elevation.md`, `foundations/colour.md`,
`quality/responsive.md`, `patterns/forms.md`, `patterns/feedback.md`, and the
entry in `reference/decisions.md`). What each decision changes in code lands in the
batch named beside it; recording the policy does not implement it.

| § 5 | Conflict | Decision | Lands in |
|---|---|---|---|
| 1 | One easing curve vs springs | **Springs only for dialogs, menus and drag.** Critically damped (damping 1, no bounce), from the `--spring` token in §6. **Colour and fade keep the brand curve** `--ease` (`cubic-bezier(.2,.7,.2,1)`) and the three duration tokens. Exits of a sprung surface run the same spring back (R7.1, R7.3); nothing else gets a spring. | Batch 2 (tokens), batch 3 (overlays) |
| 2 | Waiting for the page exit | **Page changes cross-fade, never a blank frame.** The next route mounts at once and fades in over the outgoing one; nothing waits for an exit, and there is no frame where neither page is visible. `AnimatePresence mode="wait"` goes (SYS-8). | Batch 3 |
| 3 | How much reduced motion removes | **Reduced motion keeps fades and removes movement.** Under `prefers-reduced-motion` (or the in-app setting) every translate, scale and spring is dropped, and opacity and colour changes stay at `--dur-fast`. Still nothing may hide content. | Batch 2 (`useMotionReduced`), batch 3 |
| 4 | Opaque surfaces vs translucent materials | **Translucent material only for the top bar and the command palette**, each with a **solid fallback under `prefers-reduced-transparency: reduce`**. Cards, dialogs, menus and the drawer stay opaque; the dialog overlay's blur and the no-op `.sv-frame` blur go. | Batch 2 (SYS-12) |
| 5 | Dark by default vs following the OS | **The theme follows the OS by default** (`system`), and **the manual override stays**: light, dark and the named themes remain one click away and persist per browser. | Batch 3 (SYS-19) |
| 6 | Touch-target floor | **44px targets under a coarse pointer, 24px under a fine pointer**, via the `--hit` token (SYS-6). The brand's "44 for frequent or primary actions" becomes "44 for every target on touch". | Batch 2 |
| 7 | Confirmation policy | **Type-the-name only for irreversible actions; one click for reversible ones.** Irreversible = the thing is gone or cannot be put back by the same UI (delete a job, delete completed pods, scale to 0 if the manifest will not restore it). Reversible = the UI can undo it (scale to 1 or more, set image, rollback, pause/resume, theme delete with an undo). Today's catalog is inverted (CL-4); fixing it is a later batch, and this entry records the policy only. | Batch 5 (CL-4, ST-15) |
| 8 | Three shadow steps vs "bigger surfaces read thicker" | **Four steps**, the fourth reserved for modal surfaces (dialog, drawer, palette), as SYS-14 proposes. Closest to decision 4: depth comes from shadow, not from translucency. | Batch 2 |
| 9 | Destructive button weight | **An unfilled `--st-down-fg` outline button**, tinted `--st-down-bg` on hover (SYS-7). Distinct from Cancel without becoming the loudest thing in the dialog. | Batch 2 (SYS-7, deferred from batch 1) |
| 10 | Sidebar and drawer | **Keep both exceptions** as `reference/decisions.md` records them. The drawer is a dialog, so decision 1 applies: it opens and closes on the same spring along the same path. | Batch 3 |

**Already true after batch 1.** The drawer and the palette are on the shared
`ui/Dialog` primitive, so every future change to dialog motion (decisions 1 and 3)
is made once.

---

## 6. Recommended token additions

These are proposed values for `index.css :root`. The full reasoning is in
`work/system` (SY findings file).

**Type scale.** All sizes are in rem so they follow the user's text size. The px
value at a 16px root is in brackets.

| Token | Size | Leading | Tracking | Role |
|---|---|---|---|---|
| `--fs-2xs` | .6875rem [11] | 1.35 | +.01em (uppercase: `--label-tracking` .06em) | micro labels, counts |
| `--fs-xs` | .75rem [12] | 1.4 | +.005em | meta, hostnames, tooltips |
| `--fs-sm` | .8125rem [13] | 1.45 | 0 | controls, chips, menu rows |
| `--fs-md` | .875rem [14] | 1.5 | 0 | table cells, nav |
| `--fs-body` | 1rem [16] | 1.6 | 0 | prose (`--read-fs`) |
| `--fs-lg` | 1.0625rem [17] | 1.35 | -.01em | panel and group titles |
| `--fs-xl` | 1.3125rem [21] | 1.25 | -.015em | section and dialog headings |
| `--fs-2xl` | 1.75rem [28] | 1.15 | -.02em | page h1 |
| `--fs-display` | clamp(2.375rem,6vw,4.25rem) | 1.02 | -.03em | Overview hero only |

Weights are 400, 500, 600, 700 and 800. Drop 550, 650 and 750.

**Spacing.** A 4px grid with 2px and 6px half-steps, in rem:

`--sp-0_5` 2 · `--sp-1` 4 · `--sp-1_5` 6 · `--sp-2` 8 · `--sp-2_5` 10 · `--sp-3` 12 ·
`--sp-4` 16 · `--sp-5` 20 · `--sp-6` 24 · `--sp-8` 32 · `--sp-10` 40 · `--sp-12` 48 ·
`--sp-16` 64

**Motion.**
- **Durations.** Keep `--dur-fast` 120ms, `--dur` 180ms and `--dur-slow` 260ms. Add
  `--dur-exit` 120ms and `--press-dur` 100ms.
- **Easing.** Keep `--ease` as `cubic-bezier(.2,.7,.2,1)` for enter and settle. Add
  `--ease-exit` `cubic-bezier(.4,0,.9,.4)`, and `--ease-standard`
  `cubic-bezier(.4,0,.2,1)` for reversible hover and toggle, so both directions use
  the same curve (R7.3).
- **Springs.** All critically damped (damping 1). Every response has the same curve
  shape, so one `linear()` token serves them all, and only the duration changes.
  - `--spring: linear(0,.08,.24,.408,.557,.677,.769,.837,.887,.922,.947,.964,.976,.984,.989,.993,.995,.997,.998,.999,1)`
  - `--spring-dur-s` 440ms: response 0.30. Framer:
    `{type:'spring',bounce:0,visualDuration:.3}`.
  - `--spring-dur` 520ms: response 0.35.
  - `--spring-dur-l` 590ms: response 0.40.
  - Reserve bounce (about 0.8 damping) for release after a momentum gesture. Bothy
    has none today.
- **Press.** `--press-scale` .97 (.985 for wide rows and cards).
- **Stagger.** `--stagger` 30ms, capped at 8 items.

**Elevation and materials.** Themes override only `--shadow-color` and
`--shadow-hairline`.
- `--shadow-1` (rest): `0 1px 2px`.
- `--shadow-2` (hover): `0 6px 16px -8px`.
- `--shadow-3` (popover): `0 12px 32px -12px`.
- `--shadow-4` (modal): `0 28px 72px -24px`.
- `--scrim`: `rgb(9 9 11/.38)` in light, `rgb(0 0 0/.6)` in dark.
- `--mat-chrome-bg`: `color-mix(in oklab,var(--bg) 78%,transparent)`, with
  `--mat-chrome-blur` `blur(14px) saturate(1.2)`.
- Under `prefers-reduced-transparency`, the materials become solid. Under
  `prefers-contrast: more`, `--line` goes to 28% and `--line-strong` to 45%.

**Interaction.**
- `--hit`: 2rem, or 2.75rem under `(pointer:coarse)`.
- `--ring-w` 2px and `--ring-offset` 2px. The focus rule never sets a radius.
- `--icon-xs` 12 / `-sm` 14 / `-md` 16 / `-lg` 20.
- Use `--border-w` everywhere.
- Delete `--hover-opacity` and `--track`, or adopt them.

---

## 7. Implementation order: five PR-sized batches

Each batch can ship on its own and is verified with the same harness: screenshots at
the three widths in both themes, plus the contrast and target probes.

**Batch 1: accessibility blockers.** All P0s, plus the cheap P1s that share their
files. Effort: M overall.
- SYS-3: the tag `-fg` tokens, and a theme-contract lint so a `--st-*` fill can
  never be text.
- CT-3: zero-count chips.
- CT-1: a `SortHeader` button.
- SH-1: palette Tab and Escape handling. The interim fix is fine here, and SYS-5
  replaces it.
- SYS-4, first part: keep dialogs mounted and return focus, in ServiceActions,
  KubeActions, KubeConfirm, ClusterTabs and Overview. CL-3 comes with it (inline
  ConfirmPanel).
- CL-1: portal the row menu (Radix DropdownMenu).
- SYS-2: delete the focus-rule radius.
- SYS-7: the button disabled and danger variants.
- FL-2: scope picker Escape.

**Batch 1 as shipped (2026-09-21).** All seven P0s plus the batch's keyboard and
focus items: SYS-3 (and the Inspector tag at 11px), CT-3, CT-1, SH-1 (not the
interim fix - the palette moved onto `ui/Dialog` outright), SYS-4 first part with
CL-3, CL-1 on a new `ui/Menu`, SYS-2 and FL-2. SYS-4's fix differs from the text
above in one way worth knowing: focus return is done by the primitive for both
mount styles (`{open && <Dialog/>}` and `open={x}`), because Radix calls
`onCloseAutoFocus` on unmount as well as on close, so consumers were not rewritten
to stay mounted. Two status text tokens moved to clear 4.5:1 where they are
actually painted: light `--st-up-fg` on its own tint over `--bg-2` (4.41 → 4.84),
dark `--st-off-fg` on `--surface-4` (4.05 → 4.62). Guarded by
`apps/bothy-web/checks/a11y-contract.mjs`. **Deferred:** SYS-7 (button disabled
and danger variants) moves to batch 2 - it is not a keyboard or focus item and it
restyles `.btn` app-wide.

**Batch 2: tokens and the interaction primitives.** Effort: M.
- The §6 motion, press, hit, scrim, shadow and material tokens, plus `lib/motion.ts`.
- SYS-1: the press state.
- SYS-6: hit targets.
- SYS-12: contrast, transparency and forced-colours queries.
- SYS-14: the elevation ladder and scrim.
- SYS-9: replace literal durations.
- SYS-11: the `useMotionReduced` hook.
- CT-7 and the global `font:inherit` reset.
- Settle conflicts 1, 3, 6 and 8 in `reference/decisions.md` in the same PR, and
  regenerate `tokens.md` (SYS-20).

**Batch 2 as shipped (2026-09-22).** Held by
`apps/bothy-web/checks/design-tokens.mjs` (51 assertions) and two new rules in
`lib/contract.ts` that every theme - and the theme editor, live - now answers.

| Finding | Fix |
|---|---|
| SYS-1 press state | One shared `:active` rule in `index.css`: compact controls dim (an inset `--fg` tint) and shrink to `--press-scale` .97 over `--press-dur` 100ms; rows and cards darken to `--surface-press`. Reduced motion - OS or the in-app setting - drops the scale and keeps the dim. |
| SYS-6 hit targets | `--hit`: 1.5rem (24px) fine, 2.75rem (44px) under `(pointer: coarse)` (decision 6). `min-height` on `.btn`, `.chip`, `.icon-btn`, nav, tabs, segments, `.dlg-x`, menu and palette rows; an invisible `::after` hit slop for the controls that must stay small (`.svc-act-btn`, `.fx-hbtn`, `.fx-tab-x`, copy buttons...). The hover-only Files download button shows under `(hover: none)`. |
| SYS-7 Button | `components/ui/Button.tsx` + `Button.css`: primary, secondary, ghost, **danger** (the unfilled `--st-down-fg` outline, decision 9, with an opaque hover tint so the label never drops under AA), **caution** (the old `.sa-go` amber edge), `size="sm"`, a real disabled state, `aria-pressed`, tokenised transitions. 101 call sites migrated (`buttonClass()` for links); "Delete this pod/job" and "Yes, clear all N" are danger; `.set-danger` (never defined), `.te-danger`, `.ka-small`, `.cl-small`, five `.btn.sm`s and six scoped disabled copies deleted. |
| SYS-9 motion | `lib/motion.ts` (DUR, EASE, EASE_EXIT, EASE_STANDARD, `spring(response, damping)`, SPRING short/base/long critically damped, SPRING_BOUNCE damping .8, stagger, `followFactor`) mirrored by `--dur-exit`, `--press-dur`, `--ease-exit`, `--ease-standard`, `--spring` (a sampled critically damped `linear()`), `--spring-dur-s/-/-l`, `--spring-bounce`, `--stagger`, `--loop-*`. Every literal CSS duration and bare `ease` and all 8 framer literals replaced; one `.chev` timing; the `.ov-quick-item` hover no longer snaps out; the 3D lerps are frame-rate independent. Springs are DEFINED only - overlays adopt them in batch 3. |
| SYS-11 (hook part) | `lib/useMotionReduced.ts`: the OS query OR `html[data-motion=reduce]`, re-rendering on either; replaces framer's OS-only `useReducedMotion` in AppShell, ControlShell, Services, ServiceDetail, ProjectDetail and the 3D scene; `scrollBehavior()` for the two smooth scrolls. The OS reduce block gained `animation-iteration-count: 1`. **Left:** framer entrances from opacity 0, the Live pulse, the 3D idle orbit (batch 3). |
| SYS-12 | `prefers-reduced-transparency` (solid top bar, no palette blur), `prefers-contrast: more` (lines from `--fg` at 28/45%, `--fg-subtle` raised, solid chrome - beats a named theme's 0,3,0), forced colours (wordmark painted in CanvasText, status marks filled CanvasText or hollow Canvas, `.cl-dot`/`.ka-dot` added). The dialog overlay blur, the no-op `.sv-frame` blur and the 3D label/tip blurs are gone; only `--mat-*` materials blur. |
| SYS-13 (tokens part) | The closed 9-step rem scale with per-step `--lh-*` and `--tr-*`, `--fw-*`, `--label-tracking` and `.eyebrow`; the root keeps the browser's size; `button, input, select, textarea { font: inherit }` (CT-7: no Arial); the 68px metrics moved off the bare `h1`. Migrated: ui/Button, ui/Dialog, ui/Menu, tags, badges, kbd, tooltip, tabs, chips, nav, topbar search, segments, tables, panel heads, page head, palette. **Left:** the app-wide px sweep, `--read-*` in rem (batch 4). |
| SYS-14 | Four steps, `--shadow-1` rest to `--shadow-4` modal, mixed from `--shadow-color` (alpha = strength) and `--shadow-hairline`; themes set only those two and `--scrim`. `--scrim` darkens in both themes (light: zinc-950 at 38%), asserted per theme. Every `--shadow-sm/md/lg` use mapped. |
| SYS-15 (tokens part) | `--sp-*` spacing, `--icon-*` + `ui/Icon.tsx` (`absoluteStrokeWidth`); duplicate `.dot`, `.tag`, `.tbl`, `.chip` (the pill copy never rendered), `.badge`, `.ico`, `.btn.ghost`, `.nm-text`, `.pt` deleted; dead `.hero`, `.stats`, `.card`, `.grid`, `.svc-card`, `.ov-bar`, `@keyframes bob`/`rise`, `--hover-opacity`, `--track` deleted. **Left:** the radius and spacing literal sweep and the 8 `.ov-*` duplicates in Overview.css (batch 4). |
| SYS-20 | `docs/brand/reference/tokens.md` is generated by `web/scripts/gen-tokens-doc.mjs` and the check fails when it is stale; decisions 1, 3, 6 and 8 recorded in the brand docs. |

Two named themes changed colour because the new Button rule measured them on a
dialog for the first time: Gruvbox `--surface-4` #5a524c → #4a4440 and
`--st-down-fg` → #ff9789 (red status text in its dialogs was 3.0:1), Tokyo Night
`--st-down-fg` → #f88499 (4.26 → 4.57). Screenshots before and after (5 pages ×
light/dark × 1440/390 touch, plus pressed frames) are at
`~/.local/state/bothy/design-audit/batch2/`.

**Batch 3: overlays and motion behaviour.** Effort: M–L.
- SYS-5: `ui/Menu` and `ui/Popover`. Migrate the 9 popovers, and move the palette
  onto `ui/Dialog`.
- SYS-4, second part: mirrored exits and top-anchored dialogs.
- SYS-8: page transitions without `mode="wait"`. This needs conflict 2 decided.
- SYS-10: `Disclosure` primitive and nav labels without layout animation.
- SYS-19: theme default and view-transition cross-fade. This needs conflict 5
  decided.
- SH-11: the Live pulse.
- SH-20: freeze the matrix order under the pointer.

**Batch 4: the type scale and layout rhythm.** Effort: L, mechanical, and best done
area by area.
- SYS-13: the rem type scale with tracking and leading. Order: shell and Overview,
  then Control, then Cluster, then Files (`--read-*`, FL-5 measure), then Settings.
- SYS-15: radii, spacing, icons and duplicate cleanup, done in the same files as
  they are touched.
- SYS-16: the scroll-edge shade on sticky chrome and `--topbar-h`, which covers
  ST-6.

**Batch 5: responsive and page-level polish.** Effort: M.
- SYS-17: tables as cards at 640px and below (Services, Cluster, Audit and the other
  Settings tables), plus `table-layout:fixed`.
- CT-10 and CT-11: Flat map at phone width and 3D framing. CT-17 and CT-18: 3D
  limits, keyboard path and touch hint.
- SYS-18: the state components.
- The remaining page items:
  - Shell: SH-2, SH-3, SH-4, SH-13, SH-14, SH-21.
  - Cluster: CL-4 (catalog levels; needs conflict 7), CL-8, CL-9, CL-10, CL-12,
    CL-13, CL-18, CL-19, CL-22 to CL-25.
  - Files: FL-1, FL-3, FL-7 to FL-11, FL-17 to FL-19, FL-21.
  - Settings: ST-1 to ST-3, ST-12, ST-14 to ST-16, ST-19.

FL-1 (the list parser), ST-1 (the stale draft) and CL-13 (ANSI escapes) are small,
self-contained correctness bugs. They can ride along in any batch, and they don't
need to wait for batch 5.
