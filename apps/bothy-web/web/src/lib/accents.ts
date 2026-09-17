// A fixed categorical order of panel accent hues. They only tint a panel's
// chrome and never encode meaning. Assigned by a stable hash of the panel key so
// a panel keeps its colour no matter how the list is filtered or reordered.
// Never cycled by array index.
//
// THIS COMMENT USED TO ASSERT THE OPPOSITE OF THE TRUTH. It said the accents were
// "DELIBERATELY distinct from the status palette" while `--a4` was #34d399 -
// byte-identical to `--st-up`. On the Overview a decorative spine and an "up"
// cell rendered the same green about 8px apart. A comment claiming an invariant
// is not an invariant; the check now lives beside the tokens in index.css, where
// the values are, and the arc it leaves permits exactly five.
//
// SIX BECAME FIVE, and that is a real change rather than a tidy-up: the legal hue
// arc is 120 degrees wide, and a sixth slot could not be spaced across it without
// breaking the rule. accentVar() hashes modulo the array length, so some panels
// will land on a different accent than before - which is fine, because the only
// property that ever mattered is that a given panel keeps ITS colour.
export const ACCENTS = ['--a1', '--a2', '--a3', '--a4', '--a5'] as const;

function hash(key: string): number {
  let h = 2166136261;
  for (let i = 0; i < key.length; i++) {
    h ^= key.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}

export function accentVar(key: string): string {
  return ACCENTS[hash(key) % ACCENTS.length];
}
