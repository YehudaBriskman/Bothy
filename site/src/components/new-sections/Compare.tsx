import type { ReactNode } from 'react';
import { MEMORY, MEMORY_USED_TOTAL_MIB, MODES, type ModeId } from '../../facts.ts';
import { ns } from '../../i18n/new-sections-en.ts';
import type { PageContext } from '../../page-context.ts';
import { Rich } from '../Rich.tsx';

/**
 * 23 The four sizes, compared. One real table; Bivvy is the lit column because it is the only size that installs.
 * Choosing a size (real radio buttons, no script) quiets the other three. Figures are facts.ts only: 38 MiB across
 * three containers and 960 MiB free wanted; every other cell of those two rows says "Not yet measured".
 */
export function Compare({ ctx }: { ctx: PageContext }) {
  const c = ns.compare;
  const sizes = ctx.t.home.sizes.items;
  const yes = <span className="cmp-yes">{c.yes}</span>;
  const no = <span className="cmp-no">{c.no}</span>;
  const pick = <span className="cmp-no">{c.youPick}</span>;
  // [bivvy, bothy, basecamp, cairn] per row
  const includes: ReactNode[][] = [
    [yes, yes, yes, pick],
    [yes, yes, yes, pick],
    [no, yes, yes, pick],
    [no, no, yes, pick],
  ];
  const stands = (id: ModeId): ReactNode =>
    id === 'cairn' ? <Rich text={c.cairnPlanned} /> : id === 'bivvy' ? c.installs : c.planned;
  return (
    <section id="compare" className="section nsec" aria-labelledby="compare-h">
      <header className="section-head reveal">
        <p className="eyebrow">{c.eyebrow}</p>
        <h2 id="compare-h">{c.heading}</h2>
        <p className="lede">{c.lede}</p>
      </header>
      <div className="cmp reveal">
        <fieldset className="cmp-pick">
          <legend className="visually-hidden">{c.pick}</legend>
          {['', ...MODES.map((m) => m.id)].map((id, i) => (
            <span key={id || 'all'}>
              <input
                type="radio"
                name="cmp-size"
                id={`cz-${id || 'all'}`}
                defaultChecked={i === 0}
                className="ns-radio"
              />
              <label htmlFor={`cz-${id || 'all'}`}>{id ? sizes[id as ModeId].name : c.all}</label>
            </span>
          ))}
        </fieldset>
        <div className="cmp-scroll" tabIndex={0} role="region" aria-label={c.caption}>
          <table className="cmp-t">
            <caption className="visually-hidden">{c.caption}</caption>
            <thead>
              <tr>
                <th scope="col">
                  <span className="visually-hidden">{c.row}</span>
                </th>
                {MODES.map((m) => (
                  <th key={m.id} scope="col" data-c={m.id} className={m.state === 'now' ? 'is-now' : undefined}>
                    <span className="cmp-n" translate="no">
                      {sizes[m.id].name}
                    </span>
                    <span className="cmp-tag">{sizes[m.id].tagline}</span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="cmp-grp">
                <th scope="colgroup" colSpan={5}>
                  {c.groups[0]}
                </th>
              </tr>
              {c.rows.map((r, i) => (
                <tr key={r}>
                  <th scope="row">{r}</th>
                  {MODES.map((m, k) => (
                    <td key={m.id} data-c={m.id}>
                      {includes[i]![k]}
                    </td>
                  ))}
                </tr>
              ))}
              <tr className="cmp-grp">
                <th scope="colgroup" colSpan={5}>
                  {c.groups[1]}
                </th>
              </tr>
              <tr>
                <th scope="row">{c.installs}</th>
                {MODES.map((m) => (
                  <td key={m.id} data-c={m.id} className={m.state === 'now' ? 'cmp-strong' : 'cmp-no'}>
                    {m.state === 'now' ? c.yes : stands(m.id)}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">{c.memory}</th>
                {MODES.map((m) => (
                  <td key={m.id} data-c={m.id} className={m.measured ? undefined : 'cmp-no'}>
                    {m.measured ? <Rich text={c.memoryCell(MEMORY_USED_TOTAL_MIB)} /> : c.notMeasured}
                  </td>
                ))}
              </tr>
              <tr>
                <th scope="row">{c.gate}</th>
                {MODES.map((m) => (
                  <td key={m.id} data-c={m.id} className={m.measured ? undefined : 'cmp-no'}>
                    {m.measured ? <Rich text={c.gateCell(MEMORY.gateMiB)} /> : c.notMeasured}
                  </td>
                ))}
              </tr>
            </tbody>
          </table>
        </div>
      </div>
    </section>
  );
}
