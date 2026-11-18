// The sky scenes of the S6 gallery: data only, so a node test can read it.
// Every scene is one REAL photograph (a CC0 Poly Haven pure-sky HDRI, looked at through a flat view; see img/PROVENANCE.json
// or, for the two reused ones, ../sky/PROVENANCE.json) graded by the SAME hour table as the approved sky (sky-spike/sky-keys.js),
// and moved by the same shader and pointer wake. Nothing is drawn: no ground, no landscape, no procedural cloud.
//
//   photo    image under this folder
//   depth    the shader's depth recipe for that photograph (see sky-spike/sky.js, DEPTH): which pixels count as near cloud
//   home     the hour the scene is shown at when ?hour= is absent (the hour at which this photograph is at its best)
//   sun      0 when the photograph already holds its own sun or glare (so the shader does not draw a second one), else 1
//   moon     optional: forces the moon phase, 0..1 (0.15 is a young waxing crescent), else today's real phase
//   halo     true: a faint 22-degree ring is drawn round the sun (only meaningful in thin cirrus)
export const SCENES = [
  {
    id: 'glow',
    title: 'Horizon glow',
    line: 'Clear air above a crisp band of first light: the calmest backdrop, the one text sits on best.',
    photo: 'img/glow-desk.avif',
    depth: [0.55, 0, 2.2],
    home: 6.4,
    sun: 0,
  },
  {
    id: 'deck',
    title: 'Cloud deck',
    line: 'A broken deck of afternoon cloud with a dark bank at its edge and the light spilling past: the descent arrives here.',
    photo: 'img/deck-desk.avif',
    depth: [0.34, 1.1, 3.0],
    home: 17.4,
    sun: 0,
  },
  {
    id: 'cumulus',
    title: 'Lit cumulus',
    line: 'A lone cumulus rim-lit by a low sun in deep blue air: the clearest sense of height, for the arrival.',
    photo: 'img/cumulus-desk.avif',
    depth: [0.38, 1.0, 3.0],
    home: 14.5,
    sun: 0,
  },
  {
    id: 'storm',
    title: 'Storm break',
    line: 'Dark cloud heavy overhead and the sun finding a gap: the most dramatic, for the moment before arriving.',
    photo: 'img/storm-desk.avif',
    depth: [0.3, 0.5, 3.0],
    home: 17.8,
    sun: 0,
  },
  {
    id: 'dawn',
    title: 'Dawn stratus',
    line: 'Soft pastel layers with the first light along a thin slot at the horizon: quiet, for a morning.',
    photo: 'img/dawn-desk.avif',
    depth: [0.4, 0.5, 2.6],
    home: 6.4,
    sun: 0,
  },
  {
    id: 'cirrus',
    title: 'High cirrus',
    line: 'Fine streaks of ice cloud fanning across a deep sky with a faint ring round the sun: height and air.',
    photo: 'img/cirrus-desk.avif',
    depth: [0.42, 0.9, 3.0],
    home: 11.5,
    sun: 1,
    halo: true,
  },
  {
    id: 'twilight',
    title: 'Twilight bands',
    line: 'Rose and lilac bands over a low dark cloud, the first stars and a young crescent moon: the hour the window lights.',
    photo: 'img/twilight-desk.avif',
    depth: [0.12, 0.2, 3.0],
    home: 20,
    sun: 0,
    moon: 0.15,
  },
  {
    id: 'stars',
    title: 'Starfield',
    line: 'The approved night photograph: real stars, slow drift, and the moon on its own arc.',
    photo: '../sky/night-desk.avif',
    depth: [0.45, 0.3, 3.0],
    home: 1.5,
    sun: 0,
  },
];
