# The staged dot dissolve (sky to black)

Measured by eye from three 1886x1009 captures of a reference site, then rebuilt as an original effect and measured
programmatically. The pattern is a printer's halftone; nothing is copied.

## What the reference does

| Stage | Scroll | What is on screen |
|---|---|---|
| 1 | 0 | The whole sky already wears a fine even grid of dark dots: about 2px dots on about 8px pitch, 8 to 12% coverage, over blue and cloud alike, top to bottom. The photo is otherwise crisp. |
| 2 | window mid-screen | From the bottom up the dots get denser and larger over the lower 35 to 40% of the window: about 3px to about 7px, nearly merging, coverage about 15% at the zone's upper edge to about 85% at the foot. The edge is soft and ragged, not a line: coverage varies across the width (clouds at the edges stay lighter longer). Beside the window the side columns dither to blue-black at their feet. |
| 3 | further | The photo is gone: solid ink (#09090c) with a faint residual grid (about 3%, gone within about 120px) under the caption; the next section sits on pure black. |

Behaviours reproduced: (a) the grid exists from the start; (b) coverage is a function of scroll and of height: a front
that rises from the foot as you scroll, with a smooth ramp; (c) the front is bent by smooth noise along the width;
(d) an ordered, staggered grid with graduated radii; (e) it ends in solid ink.

## What we built

- Stage 1: `.story::after` in `site/src/styles/dither.css`, a fixed radial-gradient dot tile (1.4px radius, 8px pitch,
  85% ink). Pure CSS, so it also shows with no script, on phones and with reduced motion. It sits behind every word.
- Stages 2 and 3: `site/src/story/dither.ts` draws ONE canvas (0.42 of the window tall, staggered hexagonal grid, 8px
  pitch) when the console plays, and again on resize. Coverage per row is a smoothstep ramp of depth, with the
  depth bent by two octaves of value noise along the width (330px and 95px wavelengths, fading out toward the solid foot),
  and the dot radius follows `sqrt(coverage * cell / pi)`, up to overlap so the foot is solid. Under the canvas is a
  block of ink. The pair is moved by one `translate3d` from the story scroll (`story/console.ts`): hidden under the
  hero; rises to the lower 40% as the window grows; eases up a little over the beats; sweeps the window to ink while the frame
  rolls away. No per-frame drawing, no per-pixel loop.
- Not created for reduced motion, phones or no script: those keep the static `#story-end` dissolve (`.dither-to-black`).
- The faint 3% tail of stage 3 is the soft top edge of the band as it leaves the window; there is no separate layer.

## Our numbers (ink coverage % per tenth of the window, top to bottom, 1440x900; programmatic, from the canvas alpha plus the grid)

| Scroll position | front at | 0-10 | 10-20 | 20-30 | 30-40 | 40-50 | 50-60 | 60-70 | 70-80 | 80-90 | 90-100 |
|---|---|---|---|---|---|---|---|---|---|---|---|
| stage 1 (scroll 0) | hidden | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 | 8 |
| stage 2 (window docked) | 539px | 8 | 8 | 8 | 8 | 8 | 8 | 19 | 50 | 89 | 100 |
| stage 2 (beat 2) | 512px | 8 | 8 | 8 | 8 | 8 | 10 | 26 | 63 | 95 | 100 |
| stage 2 (beat 6) | 458px | 8 | 8 | 8 | 8 | 8 | 17 | 46 | 86 | 99 | 100 |
| stage 3 (frame leaving) | 283px | 8 | 8 | 8 | 16 | 44 | 84 | 99 | 100 | 100 | 100 |
| stage 3 (gone) | -270px | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 | 100 |

Target: 8 to 12% (we have 8%), about 15% at the zone's upper edge (19% at the first band), about 85% at the foot (89 to 100%),
zone height 35 to 40% (42% band, the dense part about 35%). At 1920x1080 the same table is within 2 points.

## Contrast

The grid and the band are behind the text (z-index -1) and dark, so light text over them only gets more contrast;
`check:sky` measures the real page and stays green.
