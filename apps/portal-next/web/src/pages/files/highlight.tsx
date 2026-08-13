// ── syntax highlighting ──────────────────────────────────────────────────────
//
// Hand-rolled, and deliberately so. package.json carries react, react-router,
// framer-motion, lucide, radix-dialog and three - no highlighter and nothing
// that could stand in for one. The candidates all cost more than this page is
// worth: shiki ships a WASM oniguruma engine plus per-language TextMate grammars
// (megabytes, or a network fetch a CSP-tight same-origin portal should not
// make), highlight.js is ~120 KB minified for its common set, and prism is
// smaller but still a plugin system and a second theme to keep in sync with the
// tokens. This is ~60 lines, adds nothing to the bundle beyond itself, and
// colours the seven languages that actually live on this box.
//
// What it is NOT: a parser. It is one alternation of regexes scanned
// left-to-right, first match wins, comments and strings ordered first so a
// keyword inside a string is not recoloured. It will be wrong on pathological
// input - a `#` inside a shell string, a regex literal containing a quote - and
// that is an acceptable price for a viewer. It cannot be wrong in a way that
// matters, because every token is emitted as a React ELEMENT: content is escaped
// by React whether or not the scanner understood it, there is no innerHTML here,
// and a mis-scan is a mis-COLOUR, never a mis-render and never an injection.

import type { ReactNode } from 'react';

// Above this the highlighter is skipped and the text is rendered plain. A regex
// scan of a megabyte is not the problem; ~40k <span> elements is.
export const HIGHLIGHT_LIMIT = 200_000;

type Rules = { cls: string; re: string }[];

const STR_DQ = '"(?:\\\\[\\s\\S]|[^"\\\\])*"';
const STR_SQ = "'(?:\\\\[\\s\\S]|[^'\\\\])*'";
const NUM = '\\b(?:0[xXbo][0-9a-fA-F_]+|\\d[\\d_]*(?:\\.[\\d_]+)?(?:[eE][+-]?\\d+)?)\\b';

const RULES: Record<string, Rules> = {
  ts: [
    { cls: 'com', re: '//[^\\n]*|/\\*[\\s\\S]*?\\*/' },
    { cls: 'str', re: '`(?:\\\\[\\s\\S]|[^`\\\\])*`|' + STR_DQ + '|' + STR_SQ },
    { cls: 'kw', re: '\\b(?:import|export|from|default|const|let|var|function|return|if|else|for|while|of|in|new|class|extends|implements|interface|type|enum|async|await|try|catch|finally|throw|typeof|instanceof|as|satisfies|is|void|null|undefined|true|false|this|super|switch|case|break|continue|do|delete|yield|static|public|private|protected|readonly)\\b' },
    { cls: 'num', re: NUM },
  ],
  py: [
    { cls: 'com', re: '#[^\\n]*' },
    { cls: 'str', re: '"""[\\s\\S]*?"""|\'\'\'[\\s\\S]*?\'\'\'|' + STR_DQ + '|' + STR_SQ },
    { cls: 'kw', re: '\\b(?:def|class|return|if|elif|else|for|while|in|not|and|or|import|from|as|with|try|except|finally|raise|lambda|pass|break|continue|yield|global|nonlocal|assert|del|None|True|False|self|async|await)\\b' },
    { cls: 'num', re: NUM },
  ],
  sh: [
    { cls: 'com', re: '#[^\\n]*' },
    { cls: 'str', re: STR_DQ + "|'[^']*'" },
    { cls: 'key', re: '\\$\\{[^}\\n]*\\}|\\$[A-Za-z_][A-Za-z0-9_]*' },
    { cls: 'kw', re: '\\b(?:if|then|else|elif|fi|for|while|until|do|done|case|esac|in|function|return|export|local|readonly|source|set|unset|shift|exit|trap)\\b' },
    { cls: 'num', re: NUM },
  ],
  yml: [
    { cls: 'com', re: '#[^\\n]*' },
    { cls: 'key', re: '^[ \\t]*(?:-[ \\t]+)?[\\w.$/-]+(?=[ \\t]*:)' },
    { cls: 'str', re: STR_DQ + '|' + STR_SQ },
    { cls: 'kw', re: '\\b(?:true|false|null|yes|no|on|off)\\b' },
    { cls: 'num', re: NUM },
  ],
  json: [
    { cls: 'key', re: '"(?:\\\\[\\s\\S]|[^"\\\\])*"(?=[ \\t]*:)' },
    { cls: 'str', re: STR_DQ },
    { cls: 'kw', re: '\\b(?:true|false|null)\\b' },
    { cls: 'num', re: NUM },
  ],
  docker: [
    { cls: 'com', re: '#[^\\n]*' },
    { cls: 'kw', re: '^[ \\t]*(?:FROM|RUN|CMD|LABEL|MAINTAINER|EXPOSE|ENV|ADD|COPY|ENTRYPOINT|VOLUME|USER|WORKDIR|ARG|ONBUILD|STOPSIGNAL|HEALTHCHECK|SHELL)\\b|\\bAS\\b' },
    { cls: 'str', re: STR_DQ + '|' + STR_SQ },
    { cls: 'num', re: NUM },
  ],
  md: [
    { cls: 'str', re: '^```[\\s\\S]*?^```' },
    { cls: 'kw', re: '^#{1,6}[ \\t][^\\n]*' },
    { cls: 'com', re: '^[ \\t]*>[^\\n]*' },
    { cls: 'key', re: '\\[[^\\]\\n]*\\]\\([^)\\s]*\\)' },
    { cls: 'num', re: '`[^`\\n]+`' },
  ],
};

const SCANNERS = new Map<string, { re: RegExp; classes: string[] }>();

function scannerFor(lang: string) {
  const cached = SCANNERS.get(lang);
  if (cached) return cached;
  const rules = RULES[lang];
  if (!rules) return null;
  // One alternation, one capture group per rule - the index of the group that
  // matched IS the token class, which is why no rule may contain a capturing
  // group of its own (they are all `(?:...)`).
  const made = {
    re: new RegExp(rules.map((r) => `(${r.re})`).join('|'), 'gm'),
    classes: rules.map((r) => r.cls),
  };
  SCANNERS.set(lang, made);
  return made;
}

export function highlight(src: string, lang: string): ReactNode[] {
  const scanner = src.length > HIGHLIGHT_LIMIT ? null : scannerFor(lang);
  if (!scanner) return [src];
  const out: ReactNode[] = [];
  let last = 0;
  let n = 0;
  scanner.re.lastIndex = 0;
  for (const m of src.matchAll(scanner.re)) {
    const at = m.index ?? 0;
    if (at > last) out.push(src.slice(last, at));
    let g = 1;
    while (g <= scanner.classes.length && m[g] === undefined) g++;
    out.push(<span className={`hl-${scanner.classes[g - 1] ?? 'str'}`} key={n++}>{m[0]}</span>);
    last = at + m[0].length;
  }
  if (last < src.length) out.push(src.slice(last));
  return out;
}

/** Whether this file was too big to colour - the status strip says so rather
 *  than letting a plain-black 400 KB file look like a broken highlighter. */
export function willHighlight(src: string, lang: string): boolean {
  return src.length <= HIGHLIGHT_LIMIT && !!RULES[lang];
}

// ── the gutter ───────────────────────────────────────────────────────────────
//
// One text node, not one element per line. A 12,000-line file is 12,000 rows of
// DOM if each number is a <span>, and every one of them costs layout on a
// horizontal scroll of the code beside it. As a single pre-wrapped string it is
// one node whose line boxes land on the same baselines as the code's, because
// both inherit the same font and the same --code-lh.
//
// It scrolls WITH the code vertically (same scroll container) and sticks to the
// left horizontally, so the numbers stay put when a long line is scrolled
// sideways - which is the only reason it is in the same container at all.
export function gutterText(lines: number): string {
  const out: string[] = new Array(lines);
  for (let i = 0; i < lines; i++) out[i] = String(i + 1);
  return out.join('\n');
}

export function countLines(src: string): number {
  let n = 1;
  for (let i = 0; i < src.length; i++) if (src.charCodeAt(i) === 10) n++;
  return n;
}

// Above this the gutter is dropped. Not a DOM cost - it is one node either way -
// but a 200k-line column of numbers is 6 characters wide and pushes the code
// off the screen for no gain on a file nobody is reading by line number.
export const GUTTER_LIMIT = 50_000;
