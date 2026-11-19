# The clip in "See it move"

No recording exists yet. The section plays a **scripted clip** (78 s, six chapters): a framed browser window with a
tab strip and an address bar, the console inside it, drawn from the example fixtures and marked Example. One timeline
paints the whole window for any time T. The script is data: `src/clip/script.ts` (the pointer's acts, the state
changes, the loads), the pages are small HTML templates in `src/clip/views.ts`, the example values in
`src/clip/example.ts` (held to `fixtures/console/*.json` by `example.test.ts`), the player in `src/new-sections.ts`,
the styles in `src/styles/new-sections.css` (first frame) and `src/styles/clip.css` (the rest, loaded with the
player). The controls under the window (play, a scrubbable bar with five chapter ticks, a time label, a 1x / 1.5x / 2x
speed button, six chapter buttons) are the ones a recording would use. Nothing plays by itself, reduced motion or not.

## What each chapter shows, and what is illustrative

"Illustrative, not shipped" means: the product does not do this today; the clip draws it to show an idea, the
window says Example (and, in the Grafana chapter, "Example · illustrative"), and the hidden transcript says so.

| Chapter | On screen | Status |
|---|---|---|
| Services 0:00 | Refresh, filter chips Running / All, a search box typed into, row selection, the detail drawer (image, ports, uptime), a Restart confirm popup, a toast | Rows, states, ports, image, drawer content and Restart-with-confirm exist in the console (`ServiceActions.tsx`, `ServiceDetail.tsx`). **Illustrative, not shipped:** the Refresh button, the Running / Stopped / All chips, the "Restart automatically" toggle, the "Tell me if it stops" checkbox, the toast wording. The wiki row going from starting to up is example data. |
| Logs 0:18 | The service's Logs tab, lines streaming in with times and levels, a level menu (Error), a text filter (timeout), Follow off and Jump to latest, copy a line | A per-service Logs panel with a text filter exists (`LogPanel.tsx`) but it **polls Loki over a range; there is no live tail** (docs/guide/the-console.md). **Illustrative, not shipped:** streaming, the level menu, Follow / Jump to latest, copy-line. The log lines are invented and carry no numbers. |
| Notes 0:39 | Expand a folder, open first-run.md, search, open ports.md | The Files reader, tree, search and "Writing: read-only" exist. The two notes' text is invented example text. |
| Health 0:48 | Four tiles, a CPU line, range 1h / 6h / 24h | The four tiles are the console's own (the numbers are example). **Illustrative, not shipped:** the CPU line and the range switch. The curves are shapes, not measurements. |
| Install 0:55 | `bothy module add node-metrics` typed in a terminal, spinner, progress bar, output, the module flips to installed | The command and the module exist (`stack/modes.yml`); it is **tested on a simulated machine only, and no published release carries a module yet**. Remove this chapter if that stops being acceptable. |
| Grafana 1:05 | An example Grafana service appears in the list with an Open button; a second browser tab opens at `http://box.example:3000` with an example dashboard (four panels drawn in SVG), a hover tooltip, a time picker, then back to the Bothy tab | **Illustrative, not shipped, whole chapter.** The monitoring stack ships Grafana (docs/guide/monitoring.md) but no module installs it, `node-metrics` installs node-exporter only, and the console has no Open button or tab. The dashboard is a drawn picture with no values; the address is an example address. |

## Replacing it with a real recording

1. Put the files here: `clip.mp4` (H.264) and optionally `clip.webm` (AV1 or VP9).
2. In `src/components/new-sections/Motion.tsx` set `CLIP_FILE = { mp4: '/video/clip.mp4', webm: '/video/clip.webm' }`.
3. Set `motion.len` and `motion.chapterList[].t` in `src/i18n/new-sections-en.ts` (and `LEN`, `CHAPTERS` in
   `src/clip/script.ts`) to the recording's length and chapter starts, and rewrite `motion.transcript`.

The first press on play then creates a muted, looping, inline `<video>` and the same controls drive it; the drawn
window is hidden. Nothing is downloaded before that press, and never when Save-Data is on.

## Rules for a recording

Silent, recorded from the real app on example data, 1280 x 800, 24 fps (record at 60, encode at 24). At most **1.5 MB**
for the MP4 and the WebM each. Begin and end on the same frame so the loop does not jump. No clip may show a number the
real app did not show; a shortened sequence says "shortened" on screen. Add a `check-budgets.mjs` row for video with the
first clip and keep this folder out of "first load". The poster is the first frame (AVIF, at most 25 KB); until then
the drawn first frame is the poster.

Setup: a clean Bivvy install on the example box with six containers named as in `fixtures/console/services.json`,
browser window 1280 x 800, dark theme, no bookmarks bar, no extensions, a 14 px cursor.
