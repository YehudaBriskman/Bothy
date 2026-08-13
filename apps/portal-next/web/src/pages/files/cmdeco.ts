// ── the two decorations CodeMirror does not ship ─────────────────────────────
//
// Everything else on the editor surface is a first-party extension. These two
// are not, and the alternative to writing them was one 78 kB gzip dependency
// (`@replit/codemirror-indentation-markers`) for the first and nothing at all
// for the second. Both are line decorations - a class and two custom properties
// on a `.cm-line` - so the drawing is entirely in editor.css and this file only
// decides WHICH lines.
//
// The cost of that choice, stated: no dependency, ~150 lines, and indent depth
// is measured from LEADING WHITESPACE rather than from a syntax tree. On a
// syntax-tree implementation a guide follows the block; here it follows the
// indentation. For this box - yaml, python, shell, ts, json - those are the same
// thing, and for the one case where they are not (a wrapped argument list) the
// guide is one level shallow rather than wrong in some way that misleads.

import { RangeSetBuilder, StateEffect, StateField } from '@codemirror/state';
import { Decoration, EditorView, ViewPlugin, type DecorationSet, type ViewUpdate } from '@codemirror/view';

// Two columns, matching `tab-size: 2` in shell.css. It is not read from
// `indentUnit` because nothing here ever sets `indentUnit` - a StreamLanguage
// with no `indent` method has no opinion - and a guide every 4 columns over
// 2-space yaml draws a rule through the middle of every other key.
const UNIT = 2;
const TAB = 2;
// How far a blank line may look for the block it sits inside. A blank line has
// no indentation of its own, so it has to borrow, and borrowing across 60 blank
// lines is not a block, it is a gap.
const BLANK_SCAN = 60;

/** Leading whitespace in COLUMNS, or null for a line that is entirely blank -
 *  a distinction that matters, because a blank line's own indent is zero and
 *  drawing zero guides through the middle of a block is the artefact everyone
 *  who hand-rolls this ships first. */
function indentCols(text: string): number | null {
  let col = 0;
  for (let i = 0; i < text.length; i++) {
    const c = text.charCodeAt(i);
    if (c === 32) col++;
    else if (c === 9) col += TAB - (col % TAB);
    else return col;
  }
  return null;
}

// One pass over the viewport asks for the same line's depth several times - once
// as itself, again as a neighbour of a blank line, again during the walk that
// finds the caret's block. `doc.line(n)` is a tree lookup, so the answers are
// memoised for the pass and thrown away with it.
type Ctx = { view: EditorView; seen: Map<number, number> };

function depthAt(cx: Ctx, n: number): number {
  const hit = cx.seen.get(n);
  if (hit !== undefined) return hit;
  const doc = cx.view.state.doc;
  const own = indentCols(doc.line(n).text);
  let out: number;
  if (own !== null) {
    out = Math.floor(own / UNIT);
  } else {
    // Blank: the MINIMUM of the nearest non-blank neighbours on each side. The
    // maximum would keep drawing a block's guides through the gap after it has
    // already closed, which is a guide pointing at nothing.
    let prev = 0;
    let next = 0;
    for (let i = n - 1, k = 0; i >= 1 && k < BLANK_SCAN; i--, k++) {
      const c = indentCols(doc.line(i).text);
      if (c !== null) { prev = c; break; }
    }
    for (let i = n + 1, k = 0; i <= doc.lines && k < BLANK_SCAN; i++, k++) {
      const c = indentCols(doc.line(i).text);
      if (c !== null) { next = c; break; }
    }
    out = Math.floor(Math.min(prev, next) / UNIT);
  }
  cx.seen.set(n, out);
  return out;
}

// The block the cursor is in, as [firstLine, lastLine, guideIndex]. Walked
// outward from the cursor's line while the indentation stays at least as deep,
// which is the same rule a folding algorithm uses and needs no parse.
//
// CLAMPED to the visible lines, and that is not an approximation: the only
// question this answers is "does the line I am about to decorate belong to the
// caret's block", and every line it is asked about is on screen. Without the
// clamp, one 12,000-line indented block would be walked end to end on every
// cursor move.
function activeRun(cx: Ctx, lo: number, hi: number): { from: number; to: number; guide: number } | null {
  const state = cx.view.state;
  const cur = state.doc.lineAt(state.selection.main.head).number;
  if (cur < lo || cur > hi) return null;
  const depth = depthAt(cx, cur);
  if (depth < 1) return null;
  let from = cur;
  let to = cur;
  while (from > lo && depthAt(cx, from - 1) >= depth) from--;
  while (to < hi && depthAt(cx, to + 1) >= depth) to++;
  return { from, to, guide: depth - 1 };
}

function buildGuides(view: EditorView): DecorationSet {
  const b = new RangeSetBuilder<Decoration>();
  const doc = view.state.doc;
  const cx: Ctx = { view, seen: new Map() };
  const vis = view.visibleRanges;
  const run = vis.length
    ? activeRun(cx, doc.lineAt(vis[0].from).number, doc.lineAt(vis[vis.length - 1].to).number)
    : null;
  let last = -1;
  for (const { from, to } of view.visibleRanges) {
    for (let pos = from; pos <= to;) {
      const line = doc.lineAt(pos);
      if (line.from > last) {
        last = line.from;
        const depth = depthAt(cx, line.number);
        if (depth > 0) {
          const on = run && line.number >= run.from && line.number <= run.to ? run.guide : -99;
          b.add(line.from, line.from, Decoration.line({
            class: 'cm-fxGuides',
            attributes: { style: `--fx-guides:${depth};--fx-guide-on:${on}` },
          }));
        }
      }
      if (line.to >= doc.length) break;
      pos = line.to + 1;
    }
  }
  return b.finish();
}

/** Vertical rules at every indent level, with the one the cursor's block hangs
 *  from picked out. Recomputed on scroll, edit and cursor move - all three
 *  change the answer, and none of them is frequent enough for the viewport-sized
 *  scan below to show up. */
export const indentGuides = ViewPlugin.fromClass(class {
  decorations: DecorationSet;

  constructor(view: EditorView) { this.decorations = buildGuides(view); }

  update(u: ViewUpdate) {
    if (u.docChanged || u.viewportChanged || u.selectionSet) this.decorations = buildGuides(u.view);
  }
}, { decorations: (v) => v.decorations });

// ── the line under the pointer ───────────────────────────────────────────────
//
// A StateField rather than a plugin holding its own DecorationSet, because the
// trigger is a DOM event and a plugin that mutates its decorations outside
// `update()` has no way to ask for a redraw. An effect is the supported route,
// and it costs one empty-ish transaction per line CROSSED - not per mousemove.
const setHover = StateEffect.define<number>();

const hoverMark = Decoration.line({ class: 'cm-fxHoverLine' });

const hoverField = StateField.define<DecorationSet>({
  create: () => Decoration.none,
  update(deco, tr) {
    deco = deco.map(tr.changes);
    for (const e of tr.effects) {
      if (e.is(setHover)) deco = e.value < 0 ? Decoration.none : Decoration.set([hoverMark.range(e.value)]);
    }
    return deco;
  },
  provide: (f) => EditorView.decorations.from(f),
});

function hoveredLineStart(view: EditorView, x: number, y: number): number {
  // Precise: null outside the text, so hovering the padding under the last line
  // does not light that line up from three inches away.
  const pos = view.posAtCoords({ x, y });
  return pos == null ? -1 : view.state.doc.lineAt(pos).from;
}

export function hoverLine() {
  let at = -1;
  return [
    hoverField,
    EditorView.domEventHandlers({
      mousemove(e, view) {
        const next = hoveredLineStart(view, e.clientX, e.clientY);
        if (next === at) return false;
        at = next;
        view.dispatch({ effects: setHover.of(next) });
        return false;
      },
      mouseleave(_e, view) {
        if (at === -1) return false;
        at = -1;
        view.dispatch({ effects: setHover.of(-1) });
        return false;
      },
    }),
  ];
}
