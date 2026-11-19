import type { CSSProperties } from 'react';
import { MEMORY } from '../../facts.ts';
import { ns } from '../../i18n/new-sections-en.ts';
import { Rich } from '../Rich.tsx';

type NodeId = keyof typeof ns.hood.nodes;

function Node({ id, col, i }: { id: NodeId; col: 'l' | 'c' | 'r'; i: number }) {
  const n = ns.hood.nodes[id];
  const fact = typeof n.fact === 'function' ? n.fact(MEMORY.gateMiB) : n.fact;
  return (
    <article className={`hn hn-${col} reveal`} style={{ '--i': i } as CSSProperties} data-node={id}>
      <button type="button" className="hn-trace" aria-pressed="false" aria-label={`${ns.hood.trace}: ${n.title}`}>
        {ns.hood.trace}
      </button>
      <p className="hn-kick">{n.kicker}</p>
      <h3>{n.title}</h3>
      <p className="hn-fact">
        <Rich text={fact} />
      </p>
    </article>
  );
}

/** A connector between two rows. It draws itself when it scrolls into view (the line grows from where it starts). */
function Fork({ kind }: { kind: 'stem' | 'split' | 'drops' | 'join' }) {
  return (
    <div className={`hf hf-${kind} reveal`} aria-hidden="true">
      {kind === 'stem' && <i className="hf-c" />}
      {kind === 'split' && (
        <>
          <i className="hf-ct" />
          <i className="hf-bar" />
          <i className="hf-l" />
          <i className="hf-r" />
        </>
      )}
      {kind === 'drops' && (
        <>
          <i className="hf-l hf-full" />
          <i className="hf-r hf-full" />
        </>
      )}
      {kind === 'join' && (
        <>
          <i className="hf-l hf-up" />
          <i className="hf-r hf-up" />
          <i className="hf-bar" />
          <i className="hf-cb" />
        </>
      )}
    </div>
  );
}

/**
 * 24 Under the hood. The request path grown into one system that descends and branches sideways as you scroll: the
 * browser, the one open door, the two things behind it, what each one reads, and the machine they all run on. Every
 * box is one sourced fact (see new-sections-en.ts for where each comes from); the connectors and the boxes reveal as
 * they scroll in (the site's own reveal, so no script of its own, and with reduced motion or no script it is simply
 * all there). On a phone it is one column with a trunk line down the side. The one thing it does not draw is how the
 * console learns what is running from Docker: the plans do not state that for the installed size.
 */
export function Hood() {
  const h = ns.hood;
  return (
    <section id="hood" className="section nsec" aria-labelledby="hood-h">
      <header className="section-head reveal">
        <p className="eyebrow">{h.eyebrow}</p>
        <h2 id="hood-h">{h.heading}</h2>
        <p className="lede">{h.lede}</p>
      </header>
      <div className="hood" data-mock="hood">
        <div className="hr">
          <Node id="browser" col="c" i={0} />
        </div>
        <Fork kind="stem" />
        <div className="hr">
          <Node id="routes" col="l" i={1} />
          <Node id="edge" col="c" i={0} />
          <Node id="ping" col="r" i={1} />
        </div>
        <Fork kind="split" />
        <div className="hr">
          <Node id="console" col="l" i={0} />
          <Node id="files" col="r" i={1} />
        </div>
        <Fork kind="drops" />
        <div className="hr">
          <Node id="version" col="l" i={0} />
          <Node id="folder" col="r" i={1} />
        </div>
        <Fork kind="join" />
        <div className="hr">
          <Node id="release" col="l" i={1} />
          <Node id="machine" col="c" i={0} />
          <Node id="data" col="r" i={1} />
        </div>
      </div>
      <p className="hood-note reveal">{h.note}</p>
    </section>
  );
}
