import { Link, useParams } from 'react-router-dom';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { usePortal } from '../lib/data';
import { HOST_OVERRIDES } from '../lib/discover';
import { accentVar } from '../lib/accents';
import { ServiceIcon, StatusIcon } from '../lib/icons';
import { projectLink } from '../lib/links';
import { useProbe } from '../lib/useProbe';
import './Detail.css';

function Field({ label, children }: { label: string; children: React.ReactNode }) {
  return (
    <div className="kv">
      <div className="kv-k">{label}</div>
      <div className="kv-v">{children}</div>
    </div>
  );
}

export function ServiceDetail() {
  const { id = '' } = useParams();
  const { data } = usePortal();
  const reduce = useReducedMotion();
  const node = data.nodes.find((n) => n.id === id);

  // Orphan routes have no Docker Health — probe the URL so the detail dot is live.
  const probed = useProbe(node && node.kind === 'orphan-route' && node.url ? [node.url] : []);

  // Reveal panels on MOUNT (once). Disabled entirely under reduced motion.
  const rise = (i: number) =>
    reduce
      ? {}
      : {
          initial: { opacity: 0, y: 14 },
          animate: { opacity: 1, y: 0 },
          transition: { duration: 0.34, delay: 0.05 + i * 0.05, ease: [0.2, 0.7, 0.2, 1] as const },
        };

  if (!node) {
    return (
      <div className="page detail">
        <Link to="/services" className="back-link"><ChevronRight size={15} style={{ transform: 'rotate(180deg)' }} /> Services</Link>
        <div className="state"><h4>Service not found</h4><p>It may have stopped, or the page was reloaded from a stale link.</p></div>
      </div>
    );
  }

  const status = (node.url ? probed[node.url] : undefined) ?? node.status;
  const desc = HOST_OVERRIDES[node.host ?? '']?.desc || node.desc;
  const c = node.container;
  // Labels are compose/traefik/dev.portal config — safe to show. Env/Mounts/
  // Command are NOT surfaced here (per portal.md); they never reach this node.
  const labels = c?.labels || {};
  const labelKeys = Object.keys(labels).sort();
  const accStyle = { ['--acc' as string]: `var(${accentVar(`service:${node.id}`)})` } as React.CSSProperties;

  let panel = 0;

  return (
    <div className="page detail" style={accStyle}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/services">Services</Link>
        <ChevronRight size={13} className="sep" aria-hidden="true" />
        <Link to={projectLink(node.group)}>{node.group}</Link>
        <ChevronRight size={13} className="sep" aria-hidden="true" />
        <span className="here">{node.name}</span>
      </nav>

      <motion.header className="detail-head" {...(reduce ? {} : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.3 } })}>
        <span className="ico lg"><ServiceIcon node={node} size={28} /></span>
        <div className="detail-head-meta">
          <h1>{node.name}</h1>
          <div className="detail-head-row">
            <span className="status-pill" data-state={status}><StatusIcon status={status} size={15} showLabel /></span>
            {node.route?.provider === 'file' && <span className="tag">host process</span>}
            {node.kind === 'orphan-route' && node.route?.provider === 'docker' && <span className="tag bad">no container</span>}
            {node.kind === 'unrouted' && <span className="tag">unrouted</span>}
          </div>
        </div>
        {node.browsable && node.url && (
          <a className="btn primary" href={node.url} target="_blank" rel="noopener noreferrer">
            Open <ExternalLink size={15} />
          </a>
        )}
      </motion.header>

      {desc && <p className="detail-lede">{desc}</p>}

      <div className="dgrid">
        <motion.section className="panel span-6" {...rise(panel++)}>
          <div className="panel-h">Endpoint</div>
          <div className="panel-b">
            <div className="kv-list">
              <Field label="Host">{node.host ? <span className="mono">{node.host}</span> : <span className="dim">—</span>}</Field>
              <Field label="URL">
                {node.url ? (
                  <a className="mono link" href={node.url} target="_blank" rel="noopener noreferrer">{node.url}</a>
                ) : <span className="dim">not a web UI</span>}
              </Field>
              {node.path && <Field label="Path"><span className="mono">{node.path}</span></Field>}
              <Field label="Kind"><span className="mono">{node.kind}</span></Field>
            </div>
          </div>
        </motion.section>

        {node.route && (
          <motion.section className="panel span-6" {...rise(panel++)}>
            <div className="panel-h">Route</div>
            <div className="panel-b">
              <div className="kv-list">
                <Field label="Router"><span className="mono">{node.route.router}</span></Field>
                <Field label="Provider"><span className="mono">{node.route.provider || '—'}</span></Field>
                <Field label="Rule"><span className="mono wrap-any">{node.route.rule || '—'}</span></Field>
                {node.route.priority != null && <Field label="Priority"><span className="mono">{node.route.priority}</span></Field>}
                {node.route.entryPoints?.length ? <Field label="Entrypoints"><span className="mono">{node.route.entryPoints.join(', ')}</span></Field> : null}
                <Field label="State"><span className="mono">{node.route.status || '—'}</span></Field>
                <Field label="Target"><span className="mono wrap-any">{node.route.serverUrls.join(', ') || '—'}</span></Field>
              </div>
            </div>
          </motion.section>
        )}

        <motion.section className="panel span-6" {...rise(panel++)}>
          <div className="panel-h">Ports <span className="sub">{node.ports.length}</span></div>
          <div className="panel-b scroll">
            {node.ports.length ? (
              <div className="port-list">
                {node.ports.map((p) => (
                  <div className="port-row" key={`${p.hostIp}:${p.hostPort}/${p.proto}`}>
                    <span className="port-map">{p.hostPort}<span className="arrow">→</span>{p.containerPort ?? '?'}</span>
                    <span className="port-proto">{p.proto}</span>
                    <span className={`tag ${p.scope === 'public' ? 'public' : 'loopback'}`}>
                      {p.scope === 'public' ? 'exposed' : 'loopback'}
                    </span>
                  </div>
                ))}
              </div>
            ) : (
              <p className="dim" style={{ margin: 0, fontSize: 13 }}>No published ports.</p>
            )}
          </div>
        </motion.section>

        {c && (
          <motion.section className="panel span-6" {...rise(panel++)}>
            <div className="panel-h">Container</div>
            <div className="panel-b">
              <div className="kv-list">
                <Field label="Name"><span className="mono">{c.name}</span></Field>
                <Field label="Image"><span className="mono wrap-any">{c.image || '—'}</span></Field>
                <Field label="ID"><span className="mono">{c.id}</span></Field>
                <Field label="State"><span className="mono">{typeof c.state === 'string' ? c.state : 'running'}</span></Field>
                {c.statusText && <Field label="Status">{c.statusText}</Field>}
                {c.health && <Field label="Health"><span className="mono">{c.health.Status || '—'}{c.health.FailingStreak ? ` · ${c.health.FailingStreak} fails` : ''}</span></Field>}
              </div>
              {labelKeys.length > 0 && (
                <div className="labels-block">
                  <div className="labels-head">Labels · {labelKeys.length}</div>
                  <div className="labels-scroll">
                    {labelKeys.map((k) => (
                      <div className="label-row" key={k}>
                        <span className="label-k">{k}</span>
                        <span className="label-v">{labels[k]}</span>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          </motion.section>
        )}
      </div>
    </div>
  );
}
