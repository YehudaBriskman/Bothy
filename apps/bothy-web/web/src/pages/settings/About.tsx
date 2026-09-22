// About & health - the Bothy containers as Docker reports them, the edge as
// Traefik reports it, and where the documentation is. Everything here comes from
// the portal's existing read-only data plane; nothing is written into the page.

import { Link } from 'react-router-dom';
import { usePortal } from '../../lib/data';
import { StatusIcon } from '../../lib/icons';
import { SettingBlock } from '../../components/settings/SettingBlock';
import { Loading, Refusal, useLoad } from '../../components/settings/bits';
import { filesHref } from '../files/routes';
import { Button } from '../../components/ui/Button';

// The five, in request-path order. Named, not discovered, because "is one of
// them missing" is the question - discovery cannot report what it did not find.
const BOTHY = [
  { name: 'bothy-web', role: 'This page - static nginx' },
  { name: 'bothy-files', role: 'Files and the config forms' },
  { name: 'bothy-ops', role: 'Container, cluster and admin reads' },
  { name: 'bothy-socket-read', role: 'Docker, read-only (POST=0)' },
  { name: 'bothy-socket-write', role: 'Docker, three verbs, no container reads' },
];

export function AboutSettings() {
  return (
    <>
      <SettingBlock id="containers" badge="live"><Containers /></SettingBlock>
      <SettingBlock id="edge" badge="live"><Edge /></SettingBlock>
      <SettingBlock id="docs"><Docs /></SettingBlock>
    </>
  );
}

function Containers() {
  const { data } = usePortal();
  if (data.at === 0 && data.fails === 0) return <Loading rows={5} />;
  const byName = new Map(data.nodes.filter((n) => n.container).map((n) => [n.container!.name, n]));
  return (
    <>
      <div className="tbl-wrap scroll-shade set-tbl">
        <table className="tbl as-cards">
          <thead>
            <tr><th scope="col">Container</th><th scope="col">State</th><th scope="col">Image</th><th scope="col">Docker says</th></tr>
          </thead>
          <tbody>
            {BOTHY.map((b) => {
              const n = byName.get(b.name);
              return (
                <tr key={b.name}>
                  <td><b className="mono">{b.name}</b><span className="set-cell-sub">{b.role}</span></td>
                  <td data-label="State">{n ? <StatusIcon status={n.status} showLabel /> : <span className="dim">not found</span>}</td>
                  <td className="mono set-wrap" data-label="Image">{n?.container?.image ?? '-'}</td>
                  <td className="set-wrap" data-label="Docker says">{n?.container?.statusText ?? (data.fails > 0 ? 'the Docker read failed' : 'no such container')}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
      <p className="set-note set-tbl-note">
        The images are built on the box from this repository, so a tag names the compose project rather than a release.
        A container reported healthy has passed its own healthcheck, not merely started.
      </p>
    </>
  );
}

interface Router { name: string; rule?: string; provider?: string; status?: string; middlewares?: string[] }

async function loadEdge(signal: AbortSignal) {
  const get = async <T,>(p: string): Promise<T> => {
    const r = await fetch(p, { signal, cache: 'no-store' });
    if (!(r.headers.get('content-type') ?? '').includes('json')) {
      const e = new Error('the Traefik API route did not answer') as Error & { status: number };
      e.status = 0;
      throw e;
    }
    return r.json() as Promise<T>;
  };
  const [version, routers] = await Promise.all([
    get<{ Version?: string; Codename?: string }>('/-/api/traefik/version'),
    get<Router[]>('/-/api/traefik/http/routers'),
  ]);
  return { version, routers };
}

function Edge() {
  const { data, error, loading, reload } = useLoad((signal) => loadEdge(signal));
  if (loading) return <Loading rows={3} />;
  if (error || !data) {
    return (
      <>
        <Refusal error={error} what="the edge" />
        <Button variant="ghost" size="sm" onClick={reload}>Retry</Button>
      </>
    );
  }
  const rs = data.routers;
  const gated = rs.filter((r) => (r.middlewares ?? []).some((m) => /^sso-(viewer|editor|operator)@/.test(m)));
  const broken = rs.filter((r) => r.status && r.status !== 'enabled');
  const byGate = (g: string) => rs.filter((r) => (r.middlewares ?? []).includes(`sso-${g}@file`)).length;
  return (
    <div className="kv-list">
      <div className="kv"><div className="kv-k">Traefik</div><div className="kv-v">
        <span className="mono">{data.version.Version ?? '?'}</span>{data.version.Codename && <span className="dim"> {data.version.Codename}</span>}
      </div></div>
      <div className="kv"><div className="kv-k">Routers</div><div className="kv-v tnum">
        {rs.length} in the table, {gated.length} behind a role gate - viewer {byGate('viewer')}, editor {byGate('editor')},
        operator {byGate('operator')}.
        {broken.length > 0
          ? <span className="set-note set-warn">{broken.length} not enabled: <span className="mono">{broken.map((r) => r.name).join(', ')}</span></span>
          : <span className="set-note">Every router is enabled. A disabled one is a route that silently answers with the portal instead.</span>}
      </div></div>
      <div className="kv"><div className="kv-k">The whole table</div><div className="kv-v">
        <Link className="link" to="/control/routes">Control › Routes</Link>
      </div></div>
    </div>
  );
}

function Docs() {
  const docs = [
    { to: filesHref('guide', 'stacks', 'docs/guide/index.md'), t: 'The guide', d: 'How to use Bothy, page by page.' },
    { to: filesHref('guide', 'stacks', 'docs/guide/settings.md'), t: 'Settings', d: 'What each section here reads, and what it stores where.' },
    { to: filesHref('guide', 'stacks', 'docs/guide/roles.md'), t: 'Roles', d: 'viewer, editor, operator and shell, and what each gates.' },
    { to: filesHref('read', 'stacks', 'SECURITY.md'), t: 'Security model', d: 'The load-bearing rules, and the accepted risks.' },
    { to: filesHref('read', 'stacks', 'docs/brand/README.md'), t: 'Design system', d: 'The rules this interface is held to.' },
    { to: filesHref('read', 'stacks', 'docs/plans/settings-v2.md'), t: 'This area’s plan', d: 'Every data source Settings uses, and the ones it deliberately does not.' },
  ];
  return (
    <ul className="set-docs">
      {docs.map((x) => (
        <li key={x.t}>
          <Link className="set-doc" to={x.to}>
            <span className="set-doc-t">{x.t}</span>
            <span className="set-doc-d">{x.d}</span>
          </Link>
        </li>
      ))}
    </ul>
  );
}
