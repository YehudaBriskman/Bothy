// The chapter backdrops and when each is in view. Pure data, shared by the page (which renders one layer per scene),
// the story script (which loads a scene when its chapter is near) and tests. The photographs are the owner's picks
// from the eight sky scenes (public/scene-mock/img, CC0, provenance in PROVENANCE.json there). To use a different
// scene, change `file` here: nothing else knows which photograph it is.
export interface Scene {
  id: string;
  /** Path under the site base. */
  file: string;
  /** The chapter id the scene belongs behind. */
  chapter: string;
  /** Descent progress at which it starts to appear, is fully there, starts to leave, and is gone. */
  window: [number, number, number, number];
  /** Opacity at its fullest: the backdrop stays a backdrop. */
  max: number;
}

export const SCENES: readonly Scene[] = [
  {
    id: 'cumulus',
    file: 'scene-mock/img/cumulus-desk.avif',
    chapter: 'inside',
    window: [0.34, 0.46, 0.56, 0.64],
    max: 0.9,
  },
  { id: 'deck', file: 'scene-mock/img/deck-desk.avif', chapter: 'sizes', window: [0.54, 0.64, 0.72, 0.8], max: 0.9 },
  {
    id: 'twilight',
    file: 'scene-mock/img/twilight-desk.avif',
    chapter: 'install',
    window: [0.7, 0.8, 0.88, 0.95],
    max: 0.92,
  },
];

const sm = (a: number, b: number, x: number) => {
  const t = Math.min(1, Math.max(0, (x - a) / (b - a)));
  return t * t * (3 - 2 * t);
};

/** How visible a scene is at descent progress p: a smoothstep in, a plateau, a smoothstep out. */
export function sceneOpacity(s: Scene, p: number): number {
  const [a, b, c, d] = s.window;
  return s.max * sm(a, b, p) * (1 - sm(c, d, p));
}
