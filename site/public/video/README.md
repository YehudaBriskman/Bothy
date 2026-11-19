# The clip in "See it move"

No recording exists yet. The section plays a **scripted clip**: a framed console window, drawn from the example
fixtures and marked Example, driven by one timeline in `src/new-sections.ts` (the `STEPS`, `MOVES`, `CLICKS` and
`LOADS` arrays: a cursor that moves and clicks, text typed into the filter and the command line, a load bar, tab
changes, a row that changes state, the `bothy module add` output). The controls under it (play, a scrubbable bar with
four chapter ticks, a time label, chapter buttons) are the same ones a recording would use.

The owner asked for the `bothy module add` step on the site now; note that it is tested on a simulated machine only
and no published release carries a module yet. Remove the Modules chapter if that stops being acceptable.

## Replacing it with a real recording

1. Put the files here: `clip.mp4` (H.264) and optionally `clip.webm` (AV1 or VP9).
2. In `src/components/new-sections/Motion.tsx` set `CLIP_FILE = { mp4: '/video/clip.mp4', webm: '/video/clip.webm' }`.
3. Set `motion.len` and `motion.chapterList[].t` in `src/i18n/new-sections-en.ts` to the recording's length and chapter
   start times, and rewrite `motion.transcript`.

The first press on play then creates a muted, looping, inline `<video>` and the same controls drive it; the drawn
window is hidden. Nothing is downloaded before that press, and never when Save-Data is on.

## Rules for a recording

Silent, 20 to 40 seconds, recorded from the real app on example data, 1280 x 800, 24 fps (record at 60, encode at 24).
At most **1.5 MB** for the MP4 and the WebM each. Begin and end on the same frame so the loop does not jump. No clip may
show a number the real app did not show; a shortened sequence says "shortened" on screen. Add a `check-budgets.mjs` row
for video with the first clip and keep this folder out of "first load". The poster is the first frame (AVIF, at most
25 KB); until then the drawn first frame is the poster.

Setup: a clean Bivvy install on the example box with six containers named as in `fixtures/console/services.json`,
browser window 1280 x 800, dark theme, no bookmarks bar, no extensions, a 14 px cursor.
