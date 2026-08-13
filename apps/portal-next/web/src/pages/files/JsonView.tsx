// ── JSON, as a foldable tree ─────────────────────────────────────────────────
//
// A real preview, not coloured text. JSON is the one format on this box that is
// routinely read to answer "what is the value at this key" - package.json,
// projects.json, a tsconfig, a settings file - and highlighted source answers
// that badly: the reader scrolls looking for a brace that matches, counting
// indentation. A fold answers it directly.
//
// Three things this does that the source view cannot:
//   · collapse a subtree, and say how many entries are inside it;
//   · show the SHAPE at a glance, because a collapsed object prints its own
//     summary ({ 12 keys }) rather than an empty pair of braces;
//   · make the path to a value copyable, which is what someone reading a config
//     usually wants next.
//
// Built as React elements, like everything else here. No innerHTML, so a string
// value containing markup is text and can never be anything else.

import { useMemo, useState } from 'react';
import { ChevronRight } from 'lucide-react';

type Json = null | boolean | number | string | Json[] | { [k: string]: Json };

// Nodes expanded automatically when the view opens. Deep enough to see the shape
// of a normal config, shallow enough that package-lock.json does not paint
// 40,000 rows before the reader has asked for anything.
const AUTO_OPEN_DEPTH = 2;
const AUTO_OPEN_BUDGET = 400;

function summarise(v: Json): string {
  if (Array.isArray(v)) return v.length === 1 ? '1 item' : `${v.length} items`;
  const n = Object.keys(v as object).length;
  return n === 1 ? '1 key' : `${n} keys`;
}

function Leaf({ value }: { value: Json }) {
  if (value === null) return <span className="hl-kw">null</span>;
  switch (typeof value) {
    case 'boolean': return <span className="hl-kw">{String(value)}</span>;
    case 'number': return <span className="hl-num">{String(value)}</span>;
    default: return <span className="hl-str">&quot;{String(value)}&quot;</span>;
  }
}

function Row({ name, value, depth, path, budget }: {
  name: string | null;
  value: Json;
  depth: number;
  path: string;
  budget: { left: number };
}) {
  const branch = value !== null && typeof value === 'object';
  // The budget is spent at BUILD time, not render time, so the same node keeps
  // the same initial state across re-renders - a useState initialiser that
  // consulted a shared mutable counter on every render would flip nodes open and
  // shut as siblings mounted.
  const [open, setOpen] = useState(() => {
    if (!branch || depth >= AUTO_OPEN_DEPTH || budget.left <= 0) return false;
    budget.left -= 1;
    return true;
  });

  const pad = { paddingLeft: `${6 + depth * 14}px` };

  if (!branch) {
    return (
      <div className="fx-json-row" style={pad} title={path}>
        {name !== null && <><span className="hl-key">{name}</span><span className="fx-json-colon">:</span></>}
        <Leaf value={value} />
      </div>
    );
  }

  const entries: [string, Json][] = Array.isArray(value)
    ? value.map((v, i) => [String(i), v])
    : Object.entries(value as { [k: string]: Json });
  const [openB, closeB] = Array.isArray(value) ? ['[', ']'] : ['{', '}'];

  return (
    <>
      <button
        type="button"
        className="fx-json-row fx-json-branch"
        style={pad}
        aria-expanded={open}
        onClick={() => setOpen((o) => !o)}
        title={path}
      >
        <ChevronRight size={12} className={`fx-json-chev ${open ? 'open' : ''}`} aria-hidden="true" />
        {name !== null && <><span className="hl-key">{name}</span><span className="fx-json-colon">:</span></>}
        <span className="fx-json-brace">{openB}</span>
        {/* A collapsed branch reports its own size. An empty {} is a different
            fact from a 300-key object, and both look identical folded. */}
        {!open && <><span className="fx-json-count">{summarise(value)}</span><span className="fx-json-brace">{closeB}</span></>}
      </button>
      {open && (
        <>
          {entries.map(([k, v]) => (
            <Row
              key={k}
              name={Array.isArray(value) ? null : k}
              value={v}
              depth={depth + 1}
              path={Array.isArray(value) ? `${path}[${k}]` : `${path}${path ? '.' : ''}${k}`}
              budget={budget}
            />
          ))}
          <div className="fx-json-row fx-json-close" style={pad}>
            <span className="fx-json-brace">{closeB}</span>
          </div>
        </>
      )}
    </>
  );
}

/** Returns null when the text is not JSON, so the caller can fall back to the
 *  source view and say why - a `.json` that does not parse is a fact worth
 *  reporting, not a reason to render nothing. */
export function JsonView({ src }: { src: string }) {
  const parsed = useMemo(() => {
    try { return { ok: true as const, value: JSON.parse(src) as Json }; }
    catch (e) { return { ok: false as const, why: e instanceof Error ? e.message : 'not valid JSON' }; }
  }, [src]);

  // Remounted whenever the source changes, so a new file starts folded the way
  // it was designed to rather than inheriting the last file's open nodes.
  const budget = useMemo(() => ({ left: AUTO_OPEN_BUDGET }), [src]);

  if (!parsed.ok) {
    return (
      <div className="fx-json-bad">
        <p><b>This file is not valid JSON.</b></p>
        <p className="fx-json-why">{parsed.why}</p>
        <p>Switch to <b>Source</b> to see it as text.</p>
      </div>
    );
  }

  return (
    <div className="fx-json scroll-shade" tabIndex={0}>
      <Row name={null} value={parsed.value} depth={0} path="" budget={budget} />
    </div>
  );
}

export function isJsonParseable(src: string): boolean {
  try { JSON.parse(src); return true; } catch { return false; }
}
