// ── the keyboard bindings, written down once ─────────────────────────────────
//
// This page SHOWS its shortcuts in two places - the empty state, which is the
// one moment the centre column has nothing else to say, and the Keys sheet in
// the status strip - and it DISPATCHES one of them itself. Before this table
// those three lists were three literals in three files, and a list of keys that
// is typed out beside the handler rather than derived from it stops being true
// the first time a binding moves. A shortcut sheet that lies is worse than no
// sheet: it is the one part of the UI a reader cannot check without trying it.
//
// So: one table. `match` is present exactly when THIS app owns the dispatch, and
// the handler is required to use it rather than re-testing the key itself.
// Where it is absent the comment names who does own the binding, because the
// honest thing to write down is where to go and change it.

export type Scope = 'global' | 'page' | 'editor';

export interface Binding {
  id: string;
  /** The chord, one span per part, already resolved for this platform. */
  keys: readonly string[];
  what: string;
  scope: Scope;
  /**
   * Set only for the bindings this app dispatches from a `keydown` listener.
   * Undefined means the key belongs to a library keymap (CodeMirror's
   * `defaultKeymap` / `searchKeymap` / `historyKeymap`, installed in
   * CodeSurface.tsx), to a pointer gesture, or - for `Tab` - to the deliberate
   * ABSENCE of a binding.
   */
  match?: (e: KeyboardEvent) => boolean;
}

// Same test AppShell.tsx and CodeSurface.tsx use, so the three agree about what
// platform this is.
export const IS_MAC = typeof navigator !== 'undefined' && /mac/i.test(navigator.platform);

/** The one modifier whose name differs by platform. Everything else - Alt,
 *  Shift, Tab - is spelled the same on both. */
export const MOD = IS_MAC ? '⌘' : 'Ctrl';

// A bare letter with no modifier: the global `/` and `r` are only these keys
// when nothing else is held, or Alt-R would refresh the dashboard.
const bare = (k: string) => (e: KeyboardEvent) =>
  e.key === k && !e.metaKey && !e.ctrlKey && !e.altKey;

const mod = (k: string) => (e: KeyboardEvent) =>
  e.key.toLowerCase() === k && (e.metaKey || e.ctrlKey);

// Mod AND Alt together, which is the only free corner of the keyboard here.
// Plain Alt-← / Alt-→ is the browser's Back/Forward on Windows and Linux, and
// Mod-← / Mod-→ is CodeMirror's cursorGroupLeft/Right - so both of the obvious
// chords are already taken by something that would still fire underneath us.
// CodeMirror matches modifiers EXACTLY, so adding Alt takes the key out of its
// keymap rather than firing both.
const modAlt = (k: string) => (e: KeyboardEvent) =>
  e.key.toLowerCase() === k.toLowerCase() && e.altKey && (e.metaKey || e.ctrlKey);

export const BINDINGS: readonly Binding[] = [
  // ── the whole portal (AppShell.tsx) ────────────────────────────────────────
  { id: 'palette', keys: [MOD, 'K'], what: 'the command palette', scope: 'global', match: mod('k') },
  { id: 'search', keys: ['/'], what: 'search from anywhere', scope: 'global', match: bare('/') },
  { id: 'refresh', keys: ['r'], what: 'refresh the portal data', scope: 'global', match: bare('r') },

  // ── this page (Files.tsx) ─────────────────────────────────────────────────
  // A window listener rather than a CodeMirror binding, because it has to fire
  // from the commit-message field too and whether or not the editor chunk
  // loaded. Files.tsx consumes `match` below; that is the only reason this row
  // and that handler cannot disagree.
  { id: 'save', keys: [MOD, 'S'], what: 'save the open file to disk', scope: 'page', match: mod('s') },
  // The tab strip, from the keyboard. `close` goes through the SAME dirty guard
  // as the X on the tab - a shortcut that is the cheap way to lose an edit is
  // worse than no shortcut.
  { id: 'nexttab', keys: [MOD, 'Alt', '→'], what: 'the next tab', scope: 'page', match: modAlt('arrowright') },
  { id: 'prevtab', keys: [MOD, 'Alt', '←'], what: 'the previous tab', scope: 'page', match: modAlt('arrowleft') },
  { id: 'closetab', keys: [MOD, 'Alt', 'W'], what: 'close the tab', scope: 'page', match: modAlt('w') },

  // ── the code surface (CodeSurface.tsx) ────────────────────────────────────
  // Bound by @codemirror/{search,commands}. There is no `match` because nothing
  // here dispatches them - the keymap does, inside the editor.
  { id: 'find', keys: [MOD, 'F'], what: 'find and replace', scope: 'editor' },
  { id: 'selnext', keys: [MOD, 'D'], what: 'select the next match', scope: 'editor' },
  { id: 'moveline', keys: ['Alt', '↑ / ↓'], what: 'move the line', scope: 'editor' },
  { id: 'comment', keys: [MOD, '/'], what: 'toggle comment', scope: 'editor' },
  { id: 'undo', keys: [MOD, 'Z / Y'], what: 'undo / redo', scope: 'editor' },
  // Pointer gestures, set by facets in CodeSurface.tsx. Listed because they are
  // the two things on this page nothing else hints at.
  { id: 'caret', keys: ['Alt', 'click'], what: 'add a caret', scope: 'editor' },
  { id: 'column', keys: ['Alt', 'Shift', 'drag'], what: 'column select', scope: 'editor' },
  // The absence of a binding, stated: `indentWithTab` is deliberately NOT
  // installed, so the editor is not a keyboard trap.
  { id: 'tab', keys: ['Tab'], what: 'leaves the editor', scope: 'editor' },
];

const BY_ID = new Map(BINDINGS.map((b) => [b.id, b]));

/** True when this event is that binding. Throws on an unknown id rather than
 *  silently never matching - a typo'd id would otherwise disable a shortcut. */
export function matches(id: string, e: KeyboardEvent): boolean {
  const b = BY_ID.get(id);
  if (!b) throw new Error(`unknown binding: ${id}`);
  if (!b.match) throw new Error(`binding ${id} is not dispatched by this app`);
  return b.match(e);
}

/** The chord, for the places that show one key inline rather than the table. */
export function chordOf(id: string): readonly string[] {
  return BY_ID.get(id)?.keys ?? [];
}

/** Everything that only works with a file open in the code surface, plus Save -
 *  which is what the Keys sheet in the status strip is about. */
export const EDITOR_KEYS = BINDINGS.filter((b) => b.scope !== 'global');

/** The handful an empty pane should teach. The rest live in the Keys sheet.
 *
 * Fifteen rows is a reference card, not an empty state - it fills the pane with
 * something nobody reads and buries the one line that matters ("pick a file").
 * These six are the ones you need before you have opened anything; every
 * editor-scoped binding is useless until there is an editor. */
// Three that work RIGHT NOW with nothing open, then three you will want the
// moment something is. Deliberately not `close` - the X has no binding, and
// listing a chord that does not exist is how a reference card becomes a lie.
const STARTER = ['palette', 'search', 'refresh', 'save', 'find', 'undo'] as const;
export const STARTER_KEYS = STARTER
  .map((id) => BY_ID.get(id))
  .filter((b): b is Binding => !!b);
