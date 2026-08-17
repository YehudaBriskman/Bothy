import { Link, useParams } from 'react-router-dom';
import { ChevronRight, ExternalLink } from 'lucide-react';
import { motion, useReducedMotion } from 'framer-motion';
import { usePortal } from '../lib/data';
import { HOST_OVERRIDES, logSourceOf } from '../lib/discover';
import { LogPanel } from '../components/LogPanel';
import { systemsOf } from '../lib/systems';
import { accentVar } from '../lib/accents';
import { ServiceIcon, StatusIcon } from '../lib/icons';
import { systemLink, kindLabelOf, unknownReason } from '../lib/links';
import { ActionCell } from '../components/ServiceActions';
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
        <Link to="/control/services" className="back-link"><ChevronRight size={15} style={{ transform: 'rotate(180deg)' }} /> Services</Link>
        <div className="state"><h4>Service not found</h4><p>It may have stopped, or the page was reloaded from a stale link.</p></div>
      </div>
    );
  }

  // node.status only - one source, so this page can never disagree with the
  // system page that linked here.
  const status = node.status;
  const kind = kindLabelOf(node);
  const why = unknownReason(node);
  const desc = HOST_OVERRIDES[node.host ?? '']?.desc || node.desc;
  // The system's display title, not the raw group key - the breadcrumb used to
  // read "monitoring" while the page it links to is titled "Monitoring".
  const systemTitle =
    systemsOf(data.nodes).find((s) => s.key === node.group)?.title || node.group;
  const c = node.container;
  // Null for an @file route with no container and no declaration - there is
  // genuinely nowhere to read logs from, so the panel is omitted rather than
  // rendered empty.
  const logSource = logSourceOf(node);
  // Labels are compose/traefik/dev.portal config - safe to show. Env/Mounts/
  // Command are NOT surfaced here (per portal.md); they never reach this node.
  const labels = c?.labels || {};
  const labelKeys = Object.keys(labels).sort();
  const accStyle = { ['--acc' as string]: `var(${accentVar(`service:${node.id}`)})` } as React.CSSProperties;

  let panel = 0;

  return (
    <div className="page detail" style={accStyle}>
      <nav className="crumbs" aria-label="Breadcrumb">
        <Link to="/control/services">Services</Link>
        <ChevronRight size={13} className="sep" aria-hidden="true" />
        <Link to={systemLink(node.group)}>{systemTitle}</Link>
        <ChevronRight size={13} className="sep" aria-hidden="true" />
        <span className="here">{node.name}</span>
      </nav>

      <motion.header className="detail-head" {...(reduce ? {} : { initial: { opacity: 0, y: 10 }, animate: { opacity: 1, y: 0 }, transition: { duration: 0.3 } })}>
        <span className="ico lg"><ServiceIcon node={node} size={28} /></span>
        <div className="detail-head-meta">
          <h1>{node.name}</h1>
          <div className="detail-head-row">
            <span className="status-pill" data-state={status} title={why || undefined}>
              <StatusIcon status={status} size={15} showLabel />
            </span>
            {node.kind !== 'routed' && (
              <span className={`tag ${kind.bad ? 'bad' : ''}`} title={kind.hint}>{kind.label}</span>
            )}
          </div>
          {why && <p className="detail-why">{why}</p>}
        </div>
        {/* The two things you can DO to a service, side by side in its header.
            The action control lived only as a hover-revealed cell in the
            Services table, which meant the page dedicated to one service - the
            first place anyone looks for "stop this" - offered no way to act on
            it at all. */}
        <div className="detail-head-actions">
          {node.browsable && node.url && (
            <a className="btn primary" href={node.url} target="_blank" rel="noopener noreferrer">
              Open <ExternalLink size={15} />
            </a>
          )}
          <ActionCell node={node} />
        </div>
      </motion.header>

      {desc && <p className="detail-lede">{desc}</p>}

      <div className="dgrid">
        {/* Reachability - Endpoint + Route + Ports in ONE panel.
            These were three span-6 panels describing one thing from three
            angles: where it lives (host/url), how Traefik gets there (router,
            rule, target) and which ports Docker published. Split across three
            boxes, answering "how do I reach this?" meant reading three headers
            and holding them in your head; the Route panel also only existed
            sometimes, so the layout reflowed depending on the service. One
            panel, three labelled sections, always the same shape. */}
        <motion.section className="panel span-12" {...rise(panel++)}>
          <div className="panel-h">Reachability</div>
          <div className="panel-b">
            <div className="kv-list">
              <Field label="Host">{node.host ? <span className="mono">{node.host}</span> : <span className="dim">-</span>}</Field>
              <Field label="URL">
                {node.url ? (
                  <a className="mono link" href={node.url} target="_blank" rel="noopener noreferrer">{node.url}</a>
                ) : <span className="dim">not a web UI</span>}
              </Field>
              {node.aliases.length > 0 && (
                <Field label="Also reachable at">
                  <span className="mono wrap-any">{node.aliases.join(', ')}</span>
                </Field>
              )}
              {node.path && <Field label="Path"><span className="mono">{node.path}</span></Field>}
              {/* the shared label, not the raw enum ("orphan-route") */}
              <Field label="Kind">{kind.label}</Field>
            </div>

            {node.route && (
              <>
                <h3 className="kv-sub">Route</h3>
                <div className="kv-list">
                  <Field label="Router"><span className="mono">{node.route.router}</span></Field>
                  <Field label="Provider"><span className="mono">{node.route.provider || '-'}</span></Field>
                  <Field label="Rule"><span className="mono wrap-any">{node.route.rule || '-'}</span></Field>
                  {node.route.priority != null && <Field label="Priority"><span className="mono">{node.route.priority}</span></Field>}
                  {node.route.entryPoints?.length ? <Field label="Entrypoints"><span className="mono">{node.route.entryPoints.join(', ')}</span></Field> : null}
                  <Field label="State"><span className="mono">{node.route.status || '-'}</span></Field>
                  <Field label="Target"><span className="mono wrap-any">{node.route.serverUrls.join(', ') || '-'}</span></Field>
                </div>
              </>
            )}

            <h3 className="kv-sub">
              Published ports <span className="kv-sub-n">{node.ports.length}</span>
            </h3>
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

        {logSource && (
          <motion.section className="panel span-12" {...rise(panel++)}>
            <div className="panel-h">Logs</div>
            <div className="panel-b">
              <LogPanel source={logSource} />
            </div>
          </motion.section>
        )}

        {c && (
          <motion.section className="panel span-6" {...rise(panel++)}>
            <div className="panel-h">Container</div>
            <div className="panel-b">
              <div className="kv-list">
                <Field label="Name"><span className="mono">{c.name}</span></Field>
                <Field label="Image"><span className="mono wrap-any">{c.image || '-'}</span></Field>
                <Field label="ID"><span className="mono">{c.id}</span></Field>
                <Field label="State"><span className="mono">{typeof c.state === 'string' ? c.state : 'running'}</span></Field>
                {c.statusText && <Field label="Status">{c.statusText}</Field>}
                {c.health && <Field label="Health"><span className="mono">{c.health.Status || '-'}{c.health.FailingStreak ? ` · ${c.health.FailingStreak} fails` : ''}</span></Field>}
              </div>
              {labelKeys.length > 0 && (
                <div className="labels-block">
                  <div className="labels-head">Labels · {labelKeys.length}</div>
                  <div className="labels-scroll scroll-shade">
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
