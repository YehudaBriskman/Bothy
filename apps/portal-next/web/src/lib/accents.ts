// A fixed categorical order of panel accent hues. These are DELIBERATELY distinct
// from the status palette (green/amber/red are reserved for up/starting/down) —
// they only tint a panel's chrome, never encode meaning. Assigned by a stable
// hash of the panel key so a panel keeps its colour no matter how the list is
// filtered or reordered. Never cycled by array index.
export const ACCENTS = ['--a1', '--a2', '--a3', '--a4', '--a5', '--a6'] as const;

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
