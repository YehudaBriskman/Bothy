# Clips for "See it in motion"

No recordings exist yet. The section ships with drawn previews of the same scripts; each clip drops in by adding
its files here and pointing its id at them in `src/components/new-sections/Motion.tsx` (`CLIP_FILES`).

## Rules for every clip

Silent, 6 to 12 seconds, recorded from the real app on example data, 1280 x 800, 24 fps (record at 60, encode at 24).
H.264 MP4 plus an AV1 or VP9 WebM, at most **500 KB each**, four clips at most 2 MB in total. Begin and end on the
same frame so the loop does not jump. No clip may show a number the real app did not show; a shortened sequence says
"shortened" on screen. Add a `check-budgets.mjs` row for video (per clip 500 KB raw, total 2 MB) with the first
clip, and keep this folder out of "first load".

The page never downloads a clip before a press on play, and never when Save-Data is on. Every clip needs a one-line
caption and a transcript (already written in `src/i18n/new-sections-en.ts`; edit them if the recording differs) and
a poster, AVIF, at most 25 KB.

## Shot list

Setup: a clean Bivvy install on the example box with six containers named as in `fixtures/console/services.json`.
Browser window 1280 x 800, dark theme, no bookmarks bar, no extensions, a 14 px cursor.

| #   | Clip     | Length | Steps                                                                                                                                                                                                                                       |
| --- | -------- | ------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 1   | Services | 8 s    | 0 s the filled table, Wiki "starting" (start the Wiki container 3 s before recording). 2 s pointer to the Wiki row. 4 s its chip changes to "up" (tune the healthcheck start period; retake until it lands near 4 s). 8 s loop point.         |
| 2   | Notes    | 10 s   | 0 s tree collapsed. 1.5 s open `setup`. 3 s click `first-run.md`. 5 s scroll to the code block. 8 s hover the read-only chip. 10 s loop point.                                                                                             |
| 3   | Health   | 6 s    | 0 s all up. 2 s stop one container from a hidden terminal (a prepared script on a keypress). 3 to 4 s the Services tile changes figure and tone. 6 s loop point. If the real strip takes longer than 3 s to refresh, say "sped up".          |
| 4   | Install  | 12 s   | 0 s type `bothy install --dry-run` (40 ms a key). 2 to 5 s the four checks print. 6 s type `bothy install`. 7 to 11 s the output, cut for time with a visible "shortened" badge. 11 s "Bivvy is up". Never show a duration the real run did not take (24 to 39 s in the lab). |

A fifth clip (`bothy module add`) is blocked: it is tested against a simulated machine only and no published release
carries a module. Do not record it, and do not show it on the site, until one does.
