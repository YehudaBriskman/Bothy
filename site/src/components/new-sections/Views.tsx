import health from '../../../fixtures/console/health.json' with { type: 'json' };
import modules from '../../../fixtures/console/modules.json' with { type: 'json' };
import services from '../../../fixtures/console/services.json' with { type: 'json' };
import { ns } from '../../i18n/new-sections-en.ts';

/**
 * The console's views, drawn small from the example fixtures (fixtures/console/*.json, which console.test.ts holds
 * to the product's own types), for the scripted clip in Motion.tsx. HTML only: nothing is fetched and nothing in
 * here is interactive. An element with data-when="key:value" is shown (class "on") while the clip's state has that
 * value; the clip's script (new-sections.ts) sets the state.
 */

const CHIP: Record<string, string> = { up: 'ok', starting: 'warn', unknown: 'warn', stopped: 'off', down: 'bad' };

export function ServicesView() {
  const t = ns.views.th;
  return (
    <>
      <div className="cv-tool">
        <span
          className="cv-field f-filter"
          data-type="wiki"
          data-start="2.2"
          data-dur="0.9"
          data-ph={ns.views.filter}
        />
      </div>
      <table className="nv-t">
        <thead>
          <tr>
            <th scope="col">{t.service}</th>
            <th scope="col">{t.state}</th>
          </tr>
        </thead>
        <tbody>
          {services.nodes.map((n) => {
            const wiki = n.status === 'starting';
            return (
              <tr key={n.id} data-row={wiki ? 'wiki' : undefined} className={wiki ? 'nv-wiki' : undefined}>
                <td>{n.name}</td>
                <td>
                  {wiki ? (
                    <span className="nv-flip">
                      <span className="nv-chip is-warn sw on" data-when="svc:starting">
                        <i />
                        starting
                      </span>
                      <span className="nv-chip is-ok sw" data-when="svc:up">
                        <i />
                        up
                      </span>
                    </span>
                  ) : (
                    <span className={`nv-chip is-${CHIP[n.status] ?? 'off'}`}>
                      <i />
                      {n.status}
                    </span>
                  )}
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </>
  );
}

export function FilesView() {
  return (
    <div className="nv-files">
      <ul className="nv-tree">
        <li>README.md</li>
        <li>▾ setup</li>
        <li className="nv-ind" data-f="first" data-when="file:1">
          first-run.md
        </li>
        <li className="nv-ind">ports.md</li>
        <li>▸ journal</li>
        <li>recipes.md</li>
      </ul>
      <div className="nv-doc sw" data-when="file:1">
        <p className="nv-h">First run</p>
        <p>
          Bothy asks Docker what is running and lists it as <b>services</b>. It does not change those containers.
        </p>
        <p>
          <code translate="no" dir="ltr">
            docker compose ps
          </code>
        </p>
        <p>
          <span className="nv-pill" data-when="pill:1">
            {ns.views.readOnly}
          </span>
        </p>
      </div>
    </div>
  );
}

export function HealthView() {
  return (
    <ul className="nv-tiles">
      {health.tiles.map((t) => {
        const first = t.key === 'services';
        const num = 'num' in t.value ? t.value.num : t.value.text;
        const of = 'of' in t.value ? t.value.of : '';
        return (
          <li key={t.key} className="nv-tile" data-tile={t.key}>
            <small>{t.label}</small>
            <b>
              {first ? (
                <span className="nv-flip">
                  <span className="sw on" data-when="stop:0">
                    {num}
                    <span>{of}</span>
                  </span>
                  <span className="sw is-warn" data-when="stop:1">
                    4<span>{of}</span>
                  </span>
                </span>
              ) : (
                <>
                  {num}
                  <span>{of}</span>
                </>
              )}
            </b>
            <em>{t.sub}</em>
          </li>
        );
      })}
    </ul>
  );
}

export function ModulesView() {
  const t = ns.views;
  return (
    <table className="nv-t">
      <thead>
        <tr>
          <th scope="col">{t.th.module}</th>
          <th scope="col" className="nv-n">
            {t.th.limit}
          </th>
          <th scope="col">{t.th.state}</th>
        </tr>
      </thead>
      <tbody>
        {modules.modules.map((m) => {
          const add = !m.installed;
          return (
            <tr key={m.name} className={add ? 'nv-new' : undefined}>
              <td>
                {m.name}
                {'core' in m && m.core ? <span className="nv-dim"> ({t.core})</span> : null}
              </td>
              <td className="nv-n">{m.memory_mib} MiB</td>
              <td>
                {add ? (
                  <span className="nv-flip">
                    <span className="nv-chip is-off sw on" data-when="mod:0">
                      <i />
                      {t.notInstalled}
                    </span>
                    <span className="nv-chip is-ok sw" data-when="mod:1">
                      <i />
                      {t.installed}
                    </span>
                  </span>
                ) : (
                  <span className="nv-chip is-ok">
                    <i />
                    {t.installed}
                  </span>
                )}
              </td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}
