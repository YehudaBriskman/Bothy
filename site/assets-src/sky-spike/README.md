# Sky spike (phase 0): how it is made and how to look at it

Page: `site/public/sky-spike/` (plain files, copied untouched into `dist/sky-spike/` by the Vite build; not a route of
the React site, not in the sitemap, `noindex`). Nothing here is deployed by anything; the Pages workflow stays
dispatch-only.

## Look at it

Owner, on the box:

```
cd ~/stacks/site && npm ci && npm run build
npx vite preview --host 0.0.0.0 --port 4189      # a spare port; no Traefik, no Host() rule, no edge change
```

then `http://100.117.176.85:4189/sky-spike/` from the laptop over the tailnet (or `http://localhost:4189/sky-spike/` on
the box). Stop it with Ctrl-C. For quick edits without a build: `npx vite --host 0.0.0.0 --port 4189`.

URL switches: `?hour=17.5` forces the hour (0 to 24), `?debug=1` shows fps, frame time, canvas size and scale, the
governor step and bytes loaded, `?debug=depth` shows the colour-derived depth map, `?mix=day|dusk|night` forces one
photograph for every hour (the "one photo graded for all hours" comparison), `?gl=1` forces the canvas on a phone or a
narrow window (otherwise `hover: none` and widths up to 720 px get the CSS still).

## What it is

One real photograph per light (day, dusk, night), cross-faded and graded in a raw WebGL2 fragment shader by a table of
hour keyframes (`sky-keys.js`): night, pre-dawn, dawn, morning, noon, afternoon, golden hour, sunset, dusk, twilight,
smoothly interpolated and wrapping at midnight. Per hour the table sets the photo mix, a per-channel lift and gain (the
"LUT-like curve"), saturation, exposure, a horizon glow, haze, the moon and star strength, and the local text scrim.
The shader adds the sun (drawn on an honest arc, occluded by near cloud), the moon (a real phase from the date), a few
extra stars, haze and grain. Depth is derived from each photograph's own colour (bright unsaturated = near cloud,
saturated blue = far sky; dusk uses warm-grey against blue), so near cloud moves about 4.5 times more than far sky.

Motion: slow noise drift, pointer lean smoothed over about 0.4 s, a wake of the last ten pointer positions that rises in
0.12 s and settles monotonically over 1.4 s (peak push 5.5 % of the image), the image drawn at 1.07 times so lean never
shows an edge. Canvas scale is `min(DPR, 1.5)`, times 0.85 under 900 px, times a governor that steps 1, 0.85, 0.72, 0.6
when the average frame time passes 26 ms. Drawing stops when the tab is hidden, the canvas is off screen, or the pause
control is pressed. Reduced motion draws one still frame and never registers a pointer listener.

Arrival: a mist lifting off the dark ground (a noise front that reveals the sky from the top down while the exposure
rises), not a halftone.

No JavaScript: a CSS gradient sky (`prefers-color-scheme` is the crude hour) with every word readable. JavaScript but no
canvas (phone, `hover: none`, no WebGL2): one phone-size photograph for the hour, tinted by the same grade, ~25 KB.

## Provenance

See `public/sky-spike/ASSETS.md` and `ASSETS.json`. `bake.py` here reproduces the images from the CC0 HDRIs.
