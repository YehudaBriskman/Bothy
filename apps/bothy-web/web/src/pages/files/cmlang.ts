// ── the RULES table, as a CodeMirror language ────────────────────────────────
//
// WHY NOT `@codemirror/lang-*`. Measured against unpkg at today's versions: the
// five lezer grammars this box would need (js, py, json, md, yaml) add
// **+112 kB gzip** on top of CM's 119 kB core - more than a whole vim
// implementation - and they would colour the seven-and-a-bit languages that
// actually live here no better than the table in highlight.tsx already does,
// because that table was tuned against those files.
//
// WHY NOT `@codemirror/legacy-modes` either. 11.1 kB gzip for five stream modes
// is cheap, and it was the named fallback. It loses on the second criterion, not
// the first: it would give this page a SECOND definition of what a keyword is,
// beside the one the read-only Source view and every markdown fence already use.
// Two highlighters over one file is how the two views start disagreeing, and no
// screenshot ever catches it. It also has no answer for `docker`, and its
// html mode needs the xml + css + javascript modes underneath it.
//
// So: this adapter. 0 kB of dependency, one source of truth, and every language
// this page can label.
//
// THE ONE HONEST CAVEAT. A StreamLanguage tokenises LINE BY LINE - `stream.string`
// is one line and nothing else - which suits the `^`-anchored rules perfectly
// and breaks on the five multi-line constructs in the table: a TS/CSS `/* */`,
// a TS backtick template, a Python `"""`, an HTML `<!-- -->` and a markdown
// fence. Those cannot be expressed as a per-line regex at all, so they are
// carried in the parser STATE instead - the BLOCKS table below - and the state
// is what a re-parse from the middle of the document resumes from.

import { StreamLanguage, type StreamParser } from '@codemirror/language';
import { COMMENTS, RULES } from './highlight';

// The five token classes the palette in shell.css defines, mapped onto the
// @lezer/highlight tag NAMES that StreamLanguage's default token table
// understands. cmtheme.ts maps those tags back onto the same five custom
// properties, so the colour of a keyword is still decided in exactly one place.
const TAG: Record<string, string> = {
  com: 'comment',
  kw: 'keyword',
  str: 'string',
  num: 'number',
  key: 'propertyName',
};

type Block = { cls: string; open: RegExp; close: RegExp };

// Every construct in RULES that can span a line break. `open` and `close` are
// sticky-free globals, exec'd from an explicit lastIndex.
//
// Note what is NOT here: the single-line forms. `/* on one line */` is already
// in the RULES alternation and matches there first (see the tie-break in
// `scanLine`), so a block state is only ever entered by an opener that has no
// closer left on its line - which is exactly when the state is needed.
const BLOCKS: Record<string, Block[]> = {
  ts: [
    { cls: 'com', open: /\/\*/g, close: /\*\//g },
    { cls: 'str', open: /`/g, close: /(?<!\\)`/g },
  ],
  py: [
    { cls: 'str', open: /"""/g, close: /"""/g },
    { cls: 'str', open: /'''/g, close: /'''/g },
  ],
  css: [{ cls: 'com', open: /\/\*/g, close: /\*\//g }],
  html: [{ cls: 'com', open: /<!--/g, close: /-->/g }],
  // A fence delimiter only counts at the start of a line, which is why `^` is
  // load-bearing: with no `m` flag it anchors to index 0 of the LINE string, so
  // a mid-line ``` in prose cannot open or close a fence.
  md: [{ cls: 'str', open: /^ {0,3}```/g, close: /^ {0,3}```/g }],
};

type Span = { from: number; to: number; cls: string };
type St = { blk: number; spans: Span[]; i: number };

// Its own compiled copies of the RULES alternations. highlight.tsx caches its
// own; sharing them would mean two consumers writing `lastIndex` on one object.
const SCANNERS = new Map<string, { re: RegExp; classes: string[] } | null>();

function scannerFor(lang: string) {
  if (SCANNERS.has(lang)) return SCANNERS.get(lang)!;
  const rules = RULES[lang];
  const made = rules
    ? { re: new RegExp(rules.map((r) => `(${r.re})`).join('|'), 'gm'), classes: rules.map((r) => r.cls) }
    : null;
  SCANNERS.set(lang, made);
  return made;
}

// One line in, the coloured ranges of that line out, `state.blk` updated for the
// next line. Ranges never overlap and are strictly increasing, because `pos`
// only ever moves past what was just emitted.
function scanLine(lang: string, line: string, state: St): Span[] {
  const spans: Span[] = [];
  const blocks = BLOCKS[lang] ?? [];
  const scanner = scannerFor(lang);
  let pos = 0;

  for (;;) {
    if (state.blk >= 0) {
      const b = blocks[state.blk];
      b.close.lastIndex = pos;
      const m = b.close.exec(line);
      if (m) {
        const end = m.index + m[0].length;
        spans.push({ from: pos, to: end, cls: b.cls });
        pos = end;
        state.blk = -1;
        continue;
      }
      if (pos < line.length) spans.push({ from: pos, to: line.length, cls: b.cls });
      return spans;
    }
    if (pos >= line.length) return spans;

    let best: Span | null = null;
    let bestBlk = -1;
    if (scanner) {
      scanner.re.lastIndex = pos;
      const m = scanner.re.exec(line);
      if (m) {
        let g = 1;
        while (g <= scanner.classes.length && m[g] === undefined) g++;
        best = { from: m.index, to: m.index + m[0].length, cls: scanner.classes[g - 1] ?? 'str' };
      }
    }
    for (let i = 0; i < blocks.length; i++) {
      blocks[i].open.lastIndex = pos;
      const m = blocks[i].open.exec(line);
      // STRICTLY less-than, and that is the tie-break that keeps a closed
      // construct closed: on `/* a */ b /* c` both the RULES alternation and the
      // opener match at 0, and the alternation - which knows where the `*/` is -
      // is the one that wins.
      if (m && (!best || m.index < best.from)) {
        best = { from: m.index, to: m.index + m[0].length, cls: blocks[i].cls };
        bestBlk = i;
      }
    }
    if (!best) return spans;
    spans.push(best);
    pos = best.to;
    if (bestBlk >= 0) state.blk = bestBlk;
  }
}

const CACHE = new Map<string, StreamLanguage<St>>();

/** The CodeMirror language for one of the RULES keys, or null for a file whose
 *  language this page has no opinion about - in which case the editor renders
 *  it uncoloured rather than guessing, exactly as the Source view does. */
export function languageFor(lang: string): StreamLanguage<St> | null {
  if (!RULES[lang]) return null;
  const hit = CACHE.get(lang);
  if (hit) return hit;

  const parser: StreamParser<St> = {
    name: lang,
    startState: () => ({ blk: -1, spans: [], i: 0 }),
    // The default shallow copy would share the `spans` ARRAY between a state and
    // its copy. CodeMirror keeps old states around to resume parsing from, so
    // that sharing is a real aliasing bug, not a theoretical one.
    copyState: (s) => ({ blk: s.blk, spans: s.spans, i: s.i }),
    token(stream, state) {
      if (stream.sol()) {
        state.spans = scanLine(lang, stream.string, state);
        state.i = 0;
      }
      const span = state.spans[state.i];
      if (!span) { stream.skipToEnd(); return null; }
      if (stream.pos < span.from) {
        // The uncoloured run before the next token. Consuming it in one call
        // rather than one character at a time is the difference between N and
        // N-tokens work on a long line.
        stream.pos = span.from;
        return null;
      }
      state.i++;
      stream.pos = span.to;
      return TAG[span.cls] ?? null;
    },
    // A blank line cannot close a block and cannot start one, but it MUST leave
    // `blk` alone - the default would be to do nothing, which is right, so this
    // exists only to say that it was considered.
    blankLine: () => {},
    languageData: {
      commentTokens: COMMENTS[lang],
      // `white-space: pre` everywhere on this page; two spaces is what the
      // repo's own .editorconfig-shaped habits use, and what tab-size: 2 in
      // shell.css already renders a tab as.
      indentOnInput: undefined,
    },
  };
  const made = StreamLanguage.define(parser);
  CACHE.set(lang, made);
  return made;
}
