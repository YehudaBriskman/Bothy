// The one piece of state the story and the sky share: how far down the descent the visitor is (0..1).
// The story's scroll handler writes it; the sky engine reads it inside its single frame loop (or, when it is not
// looping, on write). No DOM here, so it is safe to import from both islands.
type Listener = (p: number) => void;
let value = 0;
const listeners = new Set<Listener>();

export const progress = {
  get: () => value,
  set(p: number) {
    value = Math.min(1, Math.max(0, p));
    for (const l of listeners) l(value);
  },
  subscribe(l: Listener): () => void {
    listeners.add(l);
    return () => listeners.delete(l);
  },
};
