import { ns } from '../../i18n/new-sections-en.ts';
import { FilesView, ModulesView, OverviewView, ServicesView } from './Views.tsx';

const VIEWS = [<ServicesView key="s" />, <OverviewView key="o" />, <FilesView key="f" />, <ModulesView key="m" />];

/**
 * 21 The parts, up close. One smaller screen with four views, chosen by real radio buttons styled as tabs, so it
 * works with no script (arrow keys move the choice natively). Drawn from the example fixtures and labelled Example.
 */
export function Parts() {
  const p = ns.parts;
  return (
    <section id="parts" className="section wrap nsec" aria-labelledby="parts-h">
      <header className="section-head reveal">
        <p className="eyebrow">{p.eyebrow}</p>
        <h2 id="parts-h">{p.heading}</h2>
        <p className="lede">{p.lede}</p>
      </header>
      <div className="ns-screen ns-tabbed reveal" data-n="4">
        <div className="ns-bar">
          <span className="ns-dots" aria-hidden="true">
            <i />
            <i />
            <i />
          </span>
          <span className="ns-badge">{ns.example}</span>
        </div>
        <fieldset className="ns-tabs">
          <legend className="visually-hidden">{p.tabsLabel}</legend>
          {p.views.map((v, i) => (
            <span key={v.id} className="ns-tabwrap">
              <input type="radio" name="parts-view" id={`pv-${i}`} defaultChecked={i === 0} className="ns-radio" />
              <label htmlFor={`pv-${i}`}>{v.name}</label>
            </span>
          ))}
        </fieldset>
        {p.views.map((v, i) => (
          <div key={v.id} className={`ns-view ns-view-${i}`}>
            <div className="ns-body">{VIEWS[i]}</div>
            <p className="ns-cap">
              <b>{v.name}.</b> {v.cap}
            </p>
          </div>
        ))}
      </div>
    </section>
  );
}
