import type { CSSProperties } from 'react';
import health from '../../../fixtures/console/health.json' with { type: 'json' };
import modules from '../../../fixtures/console/modules.json' with { type: 'json' };
import services from '../../../fixtures/console/services.json' with { type: 'json' };
import { MEMORY } from '../../facts.ts';
import { ns } from '../../i18n/new-sections-en.ts';

/**
 * The console's views, drawn small from the example fixtures (fixtures/console/*.json, which console.test.ts holds
 * to the product's own types). Shared by "the parts, up close" and the clip stand-ins. HTML only: nothing here is
 * fetched, and every value is example data.
 */

const CHIP: Record<string, string> = {
  up: 'ok',
  starting: 'warn',
  unknown: 'warn',
  stopped: 'off',
  down: 'bad',
};

export function ServicesView({ flip }: { flip?: boolean }) {
  const t = ns.parts.th;
  return (
    <table className="nv-t">
      <thead>
        <tr>
          <th scope="col">{t.service}</th>
          <th scope="col">{t.state}</th>
          <th scope="col">{t.group}</th>
        </tr>
      </thead>
      <tbody>
        {services.nodes.map((n, i) => {
          const wiki = flip && n.status === 'starting';
          return (
            <tr key={n.id} style={{ '--k': i } as CSSProperties}>
              <td>{n.name}</td>
              <td>
                {wiki ? (
                  <span className="nv-flip">
                    <span className="nv-chip is-warn nv-a">
                      <i />
                      starting
                    </span>
                    <span className="nv-chip is-ok nv-b" aria-hidden="true">
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
              <td className="nv-dim">{n.group}</td>
            </tr>
          );
        })}
      </tbody>
    </table>
  );
}

export function OverviewView({ flip }: { flip?: boolean }) {
  return (
    <ul className="nv-tiles">
      {health.tiles.map((t) => {
        const first = flip && t.key === 'services';
        const num = 'num' in t.value ? t.value.num : t.value.text;
        const of = 'of' in t.value ? t.value.of : '';
        return (
          <li key={t.key} className="nv-tile">
            <small>{t.label}</small>
            <b>
              {first ? (
                <span className="nv-flip">
                  <span className="nv-a">
                    {num}
                    <span>{of}</span>
                  </span>
                  <span className="nv-b is-warn" aria-hidden="true">
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

export function FilesView({ walk }: { walk?: boolean }) {
  return (
    <div className="nv-files">
      <ul className="nv-tree">
        <li>README.md</li>
        <li>▾ setup</li>
        <li className={`nv-ind${walk ? ' nv-sel' : ''}`}>first-run.md</li>
        <li className="nv-ind">ports.md</li>
        <li>▸ journal</li>
        <li>recipes.md</li>
      </ul>
      <div className="nv-doc">
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
          <span className="nv-pill">{ns.parts.readOnly}</span>
        </p>
      </div>
    </div>
  );
}

export function ModulesView() {
  const t = ns.parts;
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
        {modules.modules.map((m, i) => (
          <tr key={m.name} style={{ '--k': i } as CSSProperties}>
            <td>
              {m.name}
              {'core' in m && m.core ? <span className="nv-dim"> ({t.core})</span> : null}
            </td>
            <td className="nv-n">{m.memory_mib} MiB</td>
            <td>
              <span className={`nv-chip is-${m.installed ? 'ok' : 'off'}`}>
                <i />
                {m.installed ? t.installed : t.notInstalled}
              </span>
            </td>
          </tr>
        ))}
      </tbody>
    </table>
  );
}

export function TerminalView() {
  const lines = [
    'Docker answers, Compose v2 present',
    `At least ${MEMORY.gateMiB} MiB of memory free`,
    'Port 80 is free',
    'sha256 matches checksums.txt',
  ];
  return (
    <div className="nv-term" translate="no" dir="ltr">
      <p style={{ '--k': 0 } as CSSProperties}>
        <span className="nv-pr">$ </span>bothy install --dry-run
      </p>
      {lines.map((l, i) => (
        <p key={l} className="nv-dim" style={{ '--k': i + 1 } as CSSProperties}>
          {l}
        </p>
      ))}
      <p style={{ '--k': 6 } as CSSProperties}>
        <span className="nv-pr">$ </span>bothy install
      </p>
      <p className="nv-ok" style={{ '--k': 8 } as CSSProperties}>
        Bivvy is up
      </p>
    </div>
  );
}
