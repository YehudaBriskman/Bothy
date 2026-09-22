// The tabs of /control/cluster. One component per tab; the pure logic they draw
// from (topology, status, gating, the allowlist mirrors) is lib/cluster.ts, which
// checks/run.sh tests on its own.

import { useEffect, useLayoutEffect, useMemo, useRef, useState, type ReactNode } from 'react';
import { History, ListTree, MoreHorizontal, Pencil, Play, RefreshCw, ScrollText, SlidersHorizontal, Trash2 } from 'lucide-react';
import {
  findSpec, kubeGet, kubeRefusalOf,
  type ClaimsResult, type ConfigMapResult, type DeleteJobResult, type DeletePodResult,
  type DeploymentsResult, type EventsResult, type IngressesResult, type JobLogsResult, type JobsResult,
  type KubeCatalog, type KubeRefusal, type LimitRangesResult, type PatchKeyResult, type PodRow, type PodsResult,
  type PoliciesResult, type QuotasResult, type RoutesResult, type RunTemplateResult, type ServicesResult,
} from '../../lib/kube-actions';
import { useKubeRead, type ReadState } from '../../lib/kube-catalog';
import {
  ago, buildTopology, deploymentStatus, gate, jobStatus, podStatus, shortImage, valueAllowed,
  type ClusterStatus, type Gate, type TopoNode,
} from '../../lib/cluster';
import { queryRange, fmtCores, fmtSize, type Series } from '../../lib/metrics';
import { EventList, KubeDialog, Refused, type KubeDialogTab } from '../../components/KubeActions';
import { ConfirmDialog } from '../../components/KubeConfirm';
import { Dialog } from '../../components/ui/Dialog';
import { Menu } from '../../components/ui/Menu';
import { Button } from '../../components/ui/Button';

type Roles = string[];

// ── shared bits ─────────────────────────────────────────────────────────────

function Dot({ state }: { state: ClusterStatus }) {
  return <span className="cl-dot" data-state={state} aria-hidden="true" />;
}

const STATE_WORD: Record<ClusterStatus, string> = { up: 'healthy', warn: 'degraded', down: 'failing', off: 'off', unknown: 'unknown' };

/** The freshness line and the refusal note a polled read carries. */
function ReadHead<T>({ read, what, children }: { read: ReadState<T>; what: string; children?: ReactNode }) {
  return (
    <div className="cl-sub">
      <span className="dim cl-fresh">
        {read.at ? `${what} · updated ${ago(new Date(read.at).toISOString())}` : read.loading ? `Reading ${what.toLowerCase()}…` : what}
      </span>
      <span className="cl-sub-actions">
        {children}
        <Button variant="ghost" size="sm" onClick={read.reload} aria-label={`Refresh ${what}`}>
          <RefreshCw size={14} aria-hidden="true" /> Refresh
        </Button>
      </span>
    </div>
  );
}

/** A refusal. When the last good data is still on screen, say that it is stale. */
function Stale<T>({ read }: { read: ReadState<T> }) {
  if (!read.refusal) return null;
  return (
    <div className="cl-note-wrap">
      {read.data && <p className="sa-note cl-stale">Showing the last answer; the latest read failed.</p>}
      <Refused r={read.refusal} />
    </div>
  );
}

function Table({ label, head, children, empty }: { label: string; head: ReactNode; children: ReactNode; empty?: string | null }) {
  return (
    <div className="tbl-wrap cl-tbl" role="region" aria-label={label} tabIndex={0}>
      <table className="tbl">
        <thead><tr>{head}</tr></thead>
        <tbody>
          {children}
          {empty && <tr><td className="tbl-empty" colSpan={20}>{empty}</td></tr>}
        </tbody>
      </table>
    </div>
  );
}

function kv(m: Record<string, string> | null | undefined): string {
  const e = Object.entries(m ?? {});
  return e.length ? e.map(([k, v]) => `${k}=${v}`).join(', ') : '-';
}

function GatedButton({ g, onClick, title, denied, children }: { g: Gate; onClick: () => void; title: string; denied: string; children: ReactNode }) {
  if (g === 'hidden') return null;
  const on = g === 'enabled';
  return (
    <Button variant="ghost" size="sm" aria-disabled={on ? undefined : true}
      title={on ? title : denied} onClick={() => { if (on) onClick(); }}>
      {children}
    </Button>
  );
}

// ── topology ────────────────────────────────────────────────────────────────

export function TopologyTab({ ns }: { ns: string }) {
  const deps = useKubeRead<DeploymentsResult>('deployments', { namespace: ns }, 15_000);
  const svcs = useKubeRead<ServicesResult>('services', { namespace: ns }, 30_000);
  const routes = useKubeRead<RoutesResult>('routes', { namespace: ns }, 30_000);
  const ings = useKubeRead<IngressesResult>('ingresses', { namespace: ns }, 30_000);
  const topo = useMemo(
    () => buildTopology(deps.data?.deployments ?? [], svcs.data?.services ?? [], routes.data?.routes ?? [], ings.data?.ingresses ?? []),
    [deps.data, svcs.data, routes.data, ings.data],
  );
  const [open, setOpen] = useState<string | null>(null);
  const loading = !deps.data && deps.loading;
  const refusal = deps.refusal ?? svcs.refusal ?? routes.refusal ?? ings.refusal;

  return (
    <div className="cl-stack">
      <ReadHead read={deps} what="Deployment → Service → Route or Ingress" />
      {refusal && <Refused r={refusal} />}
      {loading && <p className="sa-working"><span className="sa-spin" />Reading the namespace…</p>}
      {!loading && deps.data && <TopoGraph topo={topo} onOpen={setOpen} />}
      <p className="cl-legend dim">
        {(['up', 'warn', 'down', 'off'] as ClusterStatus[]).map((s) => (
          <span key={s}><Dot state={s} /> {STATE_WORD[s]}</span>
        ))}
      </p>
      {open && <KubeDialog target={{ namespace: ns, deployment: open }} onClose={() => setOpen(null)} onChanged={deps.reload} />}
    </div>
  );
}

function TopoGraph({ topo, onOpen }: { topo: ReturnType<typeof buildTopology>; onOpen: (dep: string) => void }) {
  const box = useRef<HTMLDivElement>(null);
  const [paths, setPaths] = useState<{ d: string; key: string; state: ClusterStatus }[]>([]);
  const byId = useMemo(() => new Map([...topo.deployments, ...topo.services, ...topo.entries].map((n) => [n.id, n])), [topo]);

  // Edges are drawn from where the cards actually ARE, measured after layout,
  // so the graph follows the columns however the text wraps. Below 760px the
  // columns stack and the SVG is hidden (cluster.css): lines across a vertical
  // stack would cross everything, and each card lists its links in words anyway.
  useLayoutEffect(() => {
    const el = box.current;
    if (!el) return;
    const measure = () => {
      const base = el.getBoundingClientRect();
      const out: { d: string; key: string; state: ClusterStatus }[] = [];
      for (const e of topo.edges) {
        const a = el.querySelector<HTMLElement>(`[data-node="${CSS.escape(e.from)}"]`);
        const b = el.querySelector<HTMLElement>(`[data-node="${CSS.escape(e.to)}"]`);
        if (!a || !b) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const x1 = ra.right - base.left;
        const y1 = ra.top + ra.height / 2 - base.top;
        const x2 = rb.left - base.left;
        const y2 = rb.top + rb.height / 2 - base.top;
        const mx = (x1 + x2) / 2;
        out.push({ key: `${e.from}>${e.to}`, d: `M${x1},${y1} C${mx},${y1} ${mx},${y2} ${x2},${y2}`, state: byId.get(e.to)?.status ?? 'unknown' });
      }
      setPaths(out);
    };
    measure();
    const ro = new ResizeObserver(measure);
    ro.observe(el);
    return () => ro.disconnect();
  }, [topo, byId]);

  const linksOf = (n: TopoNode, dir: 'in' | 'out') => topo.edges
    .filter((e) => (dir === 'out' ? e.from === n.id : e.to === n.id))
    .map((e) => byId.get(dir === 'out' ? e.to : e.from)?.name)
    .filter(Boolean);

  const column = (title: string, nodes: TopoNode[], empty: string) => (
    <div className="cl-topo-col">
      <p className="cl-topo-h">{title}</p>
      {nodes.length === 0 && <p className="dim cl-topo-empty">{empty}</p>}
      {nodes.map((n) => {
        const out = linksOf(n, 'out');
        const body = (
          <>
            <span className="cl-topo-name"><Dot state={n.status} /><span className="mono">{n.name}</span>{n.kind !== 'deployment' && n.kind !== 'service' && <span className="ka-flag">{n.kind}</span>}</span>
            <span className="cl-topo-detail dim">{n.detail}</span>
            {out.length > 0 && <span className="cl-topo-links dim">→ {out.join(', ')}</span>}
            <span className="sr-only">{STATE_WORD[n.status]}</span>
          </>
        );
        return n.kind === 'deployment' ? (
          <button key={n.id} type="button" className="cl-topo-node" data-node={n.id} data-state={n.status} onClick={() => onOpen(n.name)} title={`Open ${n.name}`}>
            {body}
          </button>
        ) : (
          <div key={n.id} className="cl-topo-node" data-node={n.id} data-state={n.status}>{body}</div>
        );
      })}
    </div>
  );

  return (
    <div className="cl-topo" ref={box}>
      <svg className="cl-topo-svg" aria-hidden="true">
        {paths.map((p) => <path key={p.key} d={p.d} data-state={p.state} />)}
      </svg>
      {column('Deployments', topo.deployments, 'No deployments.')}
      {column('Services', topo.services, 'No services.')}
      {column('Routes and ingresses', topo.entries, 'Nothing routes into this namespace.')}
    </div>
  );
}

// ── workloads ───────────────────────────────────────────────────────────────

export function WorkloadsTab({ ns, catalog, roles }: { ns: string; catalog: KubeCatalog; roles: Roles }) {
  const deps = useKubeRead<DeploymentsResult>('deployments', { namespace: ns }, 10_000);
  const [open, setOpen] = useState<{ dep: string; tab: KubeDialogTab } | null>(null);
  const rows = useMemo(() => {
    const rank: Record<ClusterStatus, number> = { down: 0, warn: 1, unknown: 2, off: 3, up: 4 };
    // Exception-first (docs/brand/patterns/data-display.md): what is wrong goes on top.
    return [...(deps.data?.deployments ?? [])].sort((a, b) => rank[deploymentStatus(a)] - rank[deploymentStatus(b)] || a.name.localeCompare(b.name));
  }, [deps.data]);
  const canChange = gate(roles, findSpec(catalog, 'rollout-restart'));

  return (
    <div className="cl-stack">
      <ReadHead read={deps} what={`${rows.length} deployment${rows.length === 1 ? '' : 's'}`} />
      <Stale read={deps} />
      {canChange === 'disabled' && <p className="sa-note">Read-only for you: changing workloads needs the operator role.</p>}
      <Table
        label="Deployments"
        head={<><th>Deployment</th><th className="num">Ready</th><th>Image</th><th className="num">Rev</th><th>Age</th><th aria-label="Actions" /></>}
        empty={deps.data && rows.length === 0 ? 'No deployments in this namespace.' : null}
      >
        {rows.map((d) => (
          <tr key={d.name}>
            <td>
              <span className="cl-cell-name">
                <Dot state={deploymentStatus(d)} />
                <button type="button" className="cl-link mono" onClick={() => setOpen({ dep: d.name, tab: 'actions' })}>{d.name}</button>
                {d.paused && <span className="ka-flag">paused</span>}
              </span>
            </td>
            <td className="num mono">{d.readyReplicas}/{d.replicas}</td>
            <td className="mono cl-img" title={d.images.map((i) => i.image).join('\n')}>{d.images.map((i) => shortImage(i.image)).join(', ')}</td>
            <td className="num mono">{d.revision ?? '-'}</td>
            <td className="dim">{ago(d.createdAt)}</td>
            <td className="cl-actions-cell"><RowMenu name={d.name} onPick={(tab) => setOpen({ dep: d.name, tab })} /></td>
          </tr>
        ))}
      </Table>
      {open && (
        <KubeDialog
          key={`${open.dep}-${open.tab}`} target={{ namespace: ns, deployment: open.dep }} initialTab={open.tab}
          onClose={() => setOpen(null)} onChanged={deps.reload}
        />
      )}
    </div>
  );
}

const MENU: { tab: KubeDialogTab; label: string; Icon: typeof History }[] = [
  { tab: 'actions', label: 'Restart, scale, pause, set image', Icon: SlidersHorizontal },
  { tab: 'history', label: 'History and roll back', Icon: History },
  { tab: 'pods', label: 'Pods', Icon: ListTree },
  { tab: 'logs', label: 'Logs', Icon: ScrollText },
];

/** The row's "…" menu. On ui/Menu since 2026-09-21: the old list was absolutely
 *  positioned inside the table's scroller and got clipped by it (design audit
 *  CL-1) - at 390px only one of these four items could be seen. */
function RowMenu({ name, onPick }: { name: string; onPick: (tab: KubeDialogTab) => void }) {
  return (
    <Menu
      trigger={(
        <button type="button" className="svc-act-btn cl-menu-btn" aria-label={`Actions for ${name}`} title={`Actions for ${name}`}>
          <MoreHorizontal size={15} aria-hidden="true" />
        </button>
      )}
      items={MENU.map(({ tab, label, Icon }) => ({
        key: tab, label, icon: <Icon size={14} aria-hidden="true" />, onSelect: () => onPick(tab),
      }))}
    />
  );
}

// ── pods ────────────────────────────────────────────────────────────────────

export function PodsTab({ ns, catalog, roles }: { ns: string; catalog: KubeCatalog; roles: Roles }) {
  const pods = useKubeRead<PodsResult>('pods', { namespace: ns }, 8_000);
  const [del, setDel] = useState<PodRow | null>(null);
  const [logs, setLogs] = useState<PodRow | null>(null);
  const spec = findSpec(catalog, 'delete-pod');
  const g = gate(roles, spec);
  const rows = useMemo(() => {
    const rank: Record<ClusterStatus, number> = { down: 0, warn: 1, unknown: 2, up: 3, off: 4 };
    return [...(pods.data?.pods ?? [])].sort((a, b) => rank[podStatus(a)] - rank[podStatus(b)] || a.name.localeCompare(b.name));
  }, [pods.data]);

  return (
    <div className="cl-stack">
      <ReadHead read={pods} what={`${rows.length} pod${rows.length === 1 ? '' : 's'}`} />
      <Stale read={pods} />
      <Table
        label="Pods"
        head={<><th>Pod</th><th>Status</th><th className="num">Ready</th><th className="num">Restarts</th><th>Owner</th><th>Age</th><th aria-label="Actions" /></>}
        empty={pods.data && rows.length === 0 ? 'No pods in this namespace.' : null}
      >
        {rows.map((p) => (
          <tr key={p.name}>
            <td><span className="cl-cell-name"><Dot state={podStatus(p)} /><span className="mono">{p.name}</span></span></td>
            <td>{p.status}</td>
            <td className="num mono">{p.readyContainers}/{p.totalContainers}</td>
            <td className="num mono" data-hot={p.restarts > 5 ? 'true' : undefined}>{p.restarts}</td>
            <td className="dim">{p.owner ? `${p.owner.kind} ${p.owner.name}` : '-'}</td>
            <td className="dim">{ago(p.createdAt)}</td>
            <td className="cl-actions-cell">
              <span className="cl-row-btns">
                {(p.owner?.kind === 'Deployment' || p.owner?.kind === 'Job') && (
                  <Button variant="ghost" size="sm" onClick={() => setLogs(p)}><ScrollText size={14} aria-hidden="true" /> Logs</Button>
                )}
                {p.deletable && (
                  <GatedButton g={g} onClick={() => setDel(p)} title={`Delete ${p.name}`} denied="Deleting a pod needs the operator role">
                    <Trash2 size={14} aria-hidden="true" /> Delete
                  </GatedButton>
                )}
              </span>
            </td>
          </tr>
        ))}
      </Table>
      {del && spec && (
        <ConfirmDialog
          spec={spec} req={{ namespace: ns, pod: del.name }} what={del.name} onClose={() => setDel(null)} onDone={pods.reload}
          // A deleted pod takes its row, and the Delete button that opened
          // this, with it: fall back to the table rather than to <body>.
          returnFocusTo={() => document.querySelector<HTMLElement>('[role="region"][aria-label="Pods"]')}
          goLabel="Delete this pod"
          consequence={del.owner
            ? `${del.name} is deleted and ${del.owner.kind} ${del.owner.name} replaces it. With one replica, requests fail until the new pod is ready.`
            : `${del.name} is deleted.`}
          describe={(r: DeletePodResult) => ({ line: `Deleted ${r.deleted}.`, sub: r.owner ? `${r.owner.kind} ${r.owner.name} replaces it.` : undefined })}
        />
      )}
      {logs?.owner?.kind === 'Deployment' && (
        <KubeDialog target={{ namespace: ns, deployment: logs.owner.name }} initialTab="logs" initialPod={logs.name} onClose={() => setLogs(null)} onChanged={pods.reload} />
      )}
      {logs?.owner?.kind === 'Job' && <JobLogsDialog ns={ns} job={logs.owner.name} onClose={() => setLogs(null)} />}
    </div>
  );
}

// ── jobs ────────────────────────────────────────────────────────────────────

export function JobsTab({ ns, catalog, roles }: { ns: string; catalog: KubeCatalog; roles: Roles }) {
  const jobs = useKubeRead<JobsResult>('jobs', { namespace: ns }, 8_000);
  const [logs, setLogs] = useState<string | null>(null);
  const [del, setDel] = useState<string | null>(null);
  const [run, setRun] = useState<string | null>(null);
  const [template, setTemplate] = useState(catalog.jobTemplates[0] ?? '');
  const delSpec = findSpec(catalog, 'delete-job');
  const runSpec = findSpec(catalog, 'run-template');
  const rows = jobs.data?.jobs ?? [];

  return (
    <div className="cl-stack">
      <ReadHead read={jobs} what={`${rows.length} job${rows.length === 1 ? '' : 's'}`}>
        {runSpec && gate(roles, runSpec) !== 'hidden' && (
          <span className="cl-run">
            <label className="sr-only" htmlFor="cl-template">Job template</label>
            <select id="cl-template" className="ka-input mono ka-select" value={template} onChange={(e) => setTemplate(e.target.value)}>
              {catalog.jobTemplates.map((t) => <option key={t} value={t}>{t}</option>)}
            </select>
            <GatedButton g={gate(roles, runSpec)} onClick={() => setRun(template)} title={`Run the ${template} template`} denied="Running a job needs the operator role">
              <Play size={14} aria-hidden="true" /> Run template
            </GatedButton>
          </span>
        )}
      </ReadHead>
      <Stale read={jobs} />
      <Table
        label="Jobs"
        head={<><th>Job</th><th>Status</th><th>Template</th><th>Image</th><th>Started</th><th aria-label="Actions" /></>}
        empty={jobs.data && rows.length === 0 ? 'No jobs. Completed jobs are removed a day after they finish.' : null}
      >
        {rows.map((j) => (
          <tr key={j.name}>
            <td><span className="cl-cell-name"><Dot state={jobStatus(j.status)} /><span className="mono">{j.name}</span></span></td>
            <td>{j.status}{j.failed > 0 && j.status !== 'Failed' ? ` (${j.failed} failed)` : ''}</td>
            <td className="mono">{j.template ?? <span className="dim">-</span>}</td>
            <td className="mono cl-img">{j.images.map((i) => shortImage(i.image)).join(', ')}</td>
            <td className="dim">{ago(j.startTime ?? j.createdAt)}</td>
            <td className="cl-actions-cell">
              <span className="cl-row-btns">
                <Button variant="ghost" size="sm" onClick={() => setLogs(j.name)}><ScrollText size={14} aria-hidden="true" /> Logs</Button>
                <GatedButton g={gate(roles, delSpec)} onClick={() => setDel(j.name)} title={`Delete ${j.name}`} denied="Deleting a job needs the operator role">
                  <Trash2 size={14} aria-hidden="true" /> Delete
                </GatedButton>
              </span>
            </td>
          </tr>
        ))}
      </Table>
      {logs && <JobLogsDialog ns={ns} job={logs} onClose={() => setLogs(null)} />}
      {del && delSpec && (
        <ConfirmDialog
          spec={delSpec} req={{ namespace: ns, job: del }} what={del} onClose={() => setDel(null)} onDone={jobs.reload}
          returnFocusTo={() => document.querySelector<HTMLElement>('[role="region"][aria-label="Jobs"]')}
          goLabel="Delete this job"
          consequence={`${del} is deleted, and its pods and their logs with it (in the background). A job that is still running is stopped.`}
          describe={(r: DeleteJobResult) => ({ line: `Deleted ${r.deleted}.`, sub: 'Its pods are removed in the background.' })}
        />
      )}
      {run && runSpec && (
        <ConfirmDialog
          spec={runSpec} req={{ namespace: ns, template: run }} what={run} onClose={() => setRun(null)} onDone={jobs.reload}
          goLabel={`Run ${run} in ${ns}`}
          consequence={`A new Job is created in ${ns} from the ${run} template shipped with Bothy, on the backend deployment's current image.${run === 'migrate' ? ' It changes the database schema.' : ' It writes to the database.'}`}
          describe={(r: RunTemplateResult) => ({ line: `Started ${r.job}.`, sub: `Template ${r.template}, image ${r.image}. Its logs are on the Jobs tab.` })}
        />
      )}
    </div>
  );
}

function JobLogsDialog({ ns, job, onClose }: { ns: string; job: string; onClose: () => void }) {
  const [container, setContainer] = useState<string | undefined>(undefined);
  const [previous, setPrevious] = useState(false);
  const [nonce, setNonce] = useState(0);
  const [res, setRes] = useState<JobLogsResult | null>(null);
  const [refusal, setRefusal] = useState<KubeRefusal | null>(null);
  const [loading, setLoading] = useState(true);
  useEffect(() => {
    let live = true;
    setLoading(true);
    setRefusal(null);
    kubeGet<JobLogsResult>('job-logs', { namespace: ns, job, tail: 500, container, previous: previous ? 'true' : undefined })
      .then((r) => { if (live) setRes(r); })
      .catch((e) => { if (live) { setRes(null); setRefusal(kubeRefusalOf(e, { title: 'Read the logs of', role: 'viewer' }, job)); } })
      .finally(() => { if (live) setLoading(false); });
    return () => { live = false; };
  }, [ns, job, container, previous, nonce]);
  return (
    <Dialog open size="lg" onOpenChange={(o) => { if (!o) onClose(); }} title={<span className="sa-title">Job logs <span className="mono">{job}</span></span>} description="The last 500 lines the job's pod wrote.">
      <div className="ka-body">
        <div className="ka-row ka-row-between">
          <div className="ka-row">
            {res && res.containers.length > 1 && (
              <label className="ka-inline">
                <span className="ka-label">Container</span>
                <select className="ka-input mono ka-select" value={container ?? res.container} onChange={(e) => setContainer(e.target.value)}>
                  {res.containers.map((c) => <option key={c} value={c}>{c}</option>)}
                </select>
              </label>
            )}
            <label className="ka-check"><input type="checkbox" checked={previous} onChange={(e) => setPrevious(e.target.checked)} /> Previous instance</label>
          </div>
          <Button variant="ghost" size="sm" onClick={() => setNonce((n) => n + 1)}><RefreshCw size={14} aria-hidden="true" /> Refresh</Button>
        </div>
        <p className="sa-note">{loading ? 'Reading logs… ' : res ? <>From <span className="mono">{res.pod} / {res.container}</span></> : null}</p>
        {refusal && <Refused r={refusal} />}
        <pre className="ka-log mono" tabIndex={0} aria-label={`Logs of ${job}`}>{res?.lines.length ? res.lines.join('\n') : loading ? '' : 'No output.'}</pre>
      </div>
    </Dialog>
  );
}

// ── config ──────────────────────────────────────────────────────────────────

export function ConfigTab({ ns, catalog, roles }: { ns: string; catalog: KubeCatalog; roles: Roles }) {
  const name = catalog.configmaps[0] ?? '';
  const cm = useKubeRead<ConfigMapResult>(name ? 'configmap' : null, { namespace: ns, configmap: name }, 30_000);
  const [editing, setEditing] = useState<string | null>(null);
  const [draft, setDraft] = useState('');
  const [restart, setRestart] = useState(true);
  const [confirm, setConfirm] = useState<{ key: string; value: string; restart: boolean; from: string } | null>(null);
  const [filter, setFilter] = useState('');
  const patchG = gate(roles, findSpec(catalog, 'patch-key'));
  const rows = (cm.data?.data ?? []).filter((e) => !filter || e.key.toLowerCase().includes(filter.toLowerCase()));
  const editable = (cm.data?.data ?? []).filter((e) => e.editable).length;

  const start = (key: string, value: string) => { setEditing(key); setDraft(value); };
  const spec = confirm ? findSpec(catalog, confirm.restart ? 'patch-key-and-restart' : 'patch-key') : null;

  return (
    <div className="cl-stack">
      <ReadHead read={cm} what={`ConfigMap ${name} · ${cm.data?.data.length ?? 0} keys, ${editable} editable here`} />
      <Stale read={cm} />
      <div className="tbl-filter">
        <label className="tbl-search">
          <span className="sr-only">Filter keys</span>
          <input value={filter} onChange={(e) => setFilter(e.target.value)} placeholder="Filter keys" spellCheck={false} />
        </label>
      </div>
      <Table
        label={`ConfigMap ${name}`}
        head={<><th>Key</th><th>Value</th><th aria-label="Edit" /></>}
        empty={cm.data && rows.length === 0 ? (filter ? `No key matches "${filter}".` : 'The ConfigMap is empty.') : null}
      >
        {rows.map((e) => {
          const isEditing = editing === e.key;
          const ok = valueAllowed(catalog, e.key, draft);
          return (
            <tr key={e.key} data-editable={e.editable ? 'true' : undefined} data-cm-key={e.key}>
              <td className="mono cl-key">
                {e.key}
                {e.editable && e.meaning && <span className="cl-key-why dim">{e.meaning}</span>}
              </td>
              <td className="mono cl-val">
                {isEditing ? (
                  <form className="cl-edit" onSubmit={(ev) => { ev.preventDefault(); if (ok && draft !== e.value) setConfirm({ key: e.key, value: draft, restart, from: e.value }); }}>
                    <input
                      className="ka-input mono" value={draft} autoFocus spellCheck={false} aria-label={`New value for ${e.key}`}
                      aria-invalid={!ok} onChange={(ev) => setDraft(ev.target.value)}
                    />
                    <label className="ka-check"><input type="checkbox" checked={restart} onChange={(ev) => setRestart(ev.target.checked)} /> and restart</label>
                    <Button size="sm" type="submit" disabled={!ok || draft === e.value}>Save</Button>
                    <Button variant="ghost" size="sm" onClick={() => setEditing(null)}>Cancel</Button>
                    {!ok && <span className="ka-hint ka-bad">Must match <span className="mono">{e.pattern}</span></span>}
                  </form>
                ) : (
                  <span className="cl-wrap">{e.value === '' ? <span className="dim">(empty)</span> : e.value}</span>
                )}
              </td>
              <td className="cl-actions-cell">
                {e.editable && !isEditing && (
                  <GatedButton g={patchG} onClick={() => start(e.key, e.value)} title={`Change ${e.key}`} denied="Changing a key needs the operator role">
                    <Pencil size={14} aria-hidden="true" /> Edit
                  </GatedButton>
                )}
              </td>
            </tr>
          );
        })}
      </Table>
      <p className="sa-note">Only {Object.keys(catalog.configmapKeys).join(', ')} can be changed here; everything else belongs in the manifests. Pods read the ConfigMap when they start, so a change without a restart applies on their next restart.</p>
      {confirm && spec && (
        <ConfirmDialog
          spec={spec} req={{ namespace: ns, configmap: name, key: confirm.key, value: confirm.value }} what={confirm.key}
          onClose={() => { setConfirm(null); setEditing(null); }} onDone={cm.reload}
          // The Save button that opened this is gone once editing ends; the
          // row's Edit button comes back in its place.
          returnFocusTo={() => document.querySelector<HTMLElement>(`tr[data-cm-key="${CSS.escape(confirm.key)}"] .cl-actions-cell button`)}
          goLabel={confirm.restart ? `Set ${confirm.key} and restart` : `Set ${confirm.key}`}
          consequence={`${confirm.key} in ${ns}/${name} changes from "${confirm.from}" to "${confirm.value}".${confirm.restart ? ' Every deployment that reads this ConfigMap is then restarted, one pod at a time.' : ' Running pods keep the old value until they restart.'}`}
          describe={(r: PatchKeyResult) => ({
            line: `${r.key} is now ${r.to}.`,
            sub: r.restarted ? `Restarting ${r.restarted.join(', ') || 'nothing'}.` : `Was ${r.from ?? '(unset)'}. Applies when the pods next restart.`,
          })}
        />
      )}
    </div>
  );
}

// ── network ─────────────────────────────────────────────────────────────────

export function NetworkTab({ ns }: { ns: string }) {
  const svcs = useKubeRead<ServicesResult>('services', { namespace: ns }, 30_000);
  const routes = useKubeRead<RoutesResult>('routes', { namespace: ns }, 30_000);
  const ings = useKubeRead<IngressesResult>('ingresses', { namespace: ns }, 30_000);
  const pols = useKubeRead<PoliciesResult>('networkpolicies', { namespace: ns }, 60_000);
  return (
    <div className="cl-stack">
      <Section title="Services" read={svcs}>
        <Table label="Services" head={<><th>Service</th><th>Type</th><th>Cluster IP</th><th>Ports</th><th>Selector</th></>} empty={svcs.data?.services.length === 0 ? 'No services.' : null}>
          {svcs.data?.services.map((s) => (
            <tr key={s.name}>
              <td className="mono">{s.name}</td><td>{s.type}</td><td className="mono">{s.clusterIP}</td>
              <td className="mono">{s.ports.map((p) => `${p.port}${p.targetPort !== p.port ? `→${p.targetPort}` : ''}/${p.protocol}${p.nodePort ? ` (node ${p.nodePort})` : ''}`).join(', ')}</td>
              <td className="mono dim">{kv(s.selector)}</td>
            </tr>
          ))}
        </Table>
      </Section>
      <Section title="Routes" read={routes}>
        <Table label="Routes" head={<><th>Route</th><th>Host</th><th>Service</th><th>TLS</th></>} empty={routes.data?.routes.length === 0 ? 'No routes.' : null}>
          {routes.data?.routes.map((r) => (
            <tr key={r.name}>
              <td className="mono">{r.name}</td><td className="mono cl-wrap">{r.host}{r.path ?? ''}</td>
              <td className="mono">{r.service}{r.targetPort ? `:${r.targetPort}` : ''}</td><td>{r.tls ?? <span className="dim">none</span>}</td>
            </tr>
          ))}
        </Table>
      </Section>
      <Section title="Ingresses" read={ings}>
        <Table label="Ingresses" head={<><th>Ingress</th><th>Class</th><th>Rules</th></>} empty={ings.data?.ingresses.length === 0 ? 'No ingresses.' : null}>
          {ings.data?.ingresses.map((i) => (
            <tr key={i.name}>
              <td className="mono">{i.name}</td><td>{i.className ?? <span className="dim">default</span>}</td>
              <td className="mono cl-wrap">{i.rules.map((r) => `${r.host ?? '*'}${r.path ?? '/'} → ${r.service}${r.port ? `:${r.port}` : ''}`).join('; ')}</td>
            </tr>
          ))}
        </Table>
      </Section>
      <Section title="Network policies" read={pols}>
        <Table label="Network policies" head={<><th>Policy</th><th>Pods</th><th>Types</th><th>Allows</th></>} empty={pols.data?.policies.length === 0 ? 'No network policies: every pod may reach every other.' : null}>
          {pols.data?.policies.map((p) => (
            <tr key={p.name}>
              <td className="mono">{p.name}</td><td className="mono">{Object.keys(p.podSelector).length ? kv(p.podSelector) : 'all pods'}</td>
              <td>{p.policyTypes.join(', ')}</td>
              <td className="cl-wrap">{[...p.ingress.map((x) => `in: ${x}`), ...p.egress.map((x) => `out: ${x}`)].join('; ') || <span className="dim">nothing (deny)</span>}</td>
            </tr>
          ))}
        </Table>
      </Section>
    </div>
  );
}

function Section<T>({ title, read, children }: { title: string; read: ReadState<T>; children: ReactNode }) {
  return (
    <section className="cl-section" aria-label={title}>
      <h2 className="cl-h2">{title}</h2>
      <Stale read={read} />
      {!read.data && read.loading ? <p className="sa-working"><span className="sa-spin" />Reading…</p> : read.data ? children : null}
    </section>
  );
}

// ── storage ─────────────────────────────────────────────────────────────────

export function StorageTab({ ns }: { ns: string }) {
  const pvcs = useKubeRead<ClaimsResult>('persistentvolumeclaims', { namespace: ns }, 30_000);
  const quotas = useKubeRead<QuotasResult>('resourcequotas', { namespace: ns }, 60_000);
  const limits = useKubeRead<LimitRangesResult>('limitranges', { namespace: ns }, 60_000);
  return (
    <div className="cl-stack">
      <Section title="Volume claims" read={pvcs}>
        <Table label="Volume claims" head={<><th>Claim</th><th>Status</th><th className="num">Size</th><th>Access</th><th>Class</th><th>Volume</th></>} empty={pvcs.data?.claims.length === 0 ? 'No volume claims.' : null}>
          {pvcs.data?.claims.map((c) => (
            <tr key={c.name}>
              <td><span className="cl-cell-name"><Dot state={c.phase === 'Bound' ? 'up' : c.phase === 'Pending' ? 'warn' : 'down'} /><span className="mono">{c.name}</span></span></td>
              <td>{c.phase}</td><td className="num mono">{c.capacity ?? c.requested ?? '-'}</td>
              <td className="mono">{c.accessModes.join(', ')}</td><td className="mono">{c.storageClass ?? '-'}</td>
              <td className="mono dim cl-wrap">{c.volume ?? '-'}</td>
            </tr>
          ))}
        </Table>
      </Section>
      <Section title="Resource quotas" read={quotas}>
        <Table label="Resource quotas" head={<><th>Quota</th><th>Resource</th><th className="num">Used</th><th className="num">Limit</th></>} empty={quotas.data?.quotas.length === 0 ? 'No quotas: the namespace can use whatever the node has.' : null}>
          {quotas.data?.quotas.flatMap((q) => Object.keys(q.hard).sort().map((r, i) => (
            <tr key={`${q.name}-${r}`}>
              <td className="mono">{i === 0 ? q.name : ''}</td><td className="mono">{r}</td>
              <td className="num mono">{q.used[r] ?? '-'}</td><td className="num mono">{q.hard[r]}</td>
            </tr>
          )))}
        </Table>
      </Section>
      <Section title="Limit ranges" read={limits}>
        <Table label="Limit ranges" head={<><th>Range</th><th>Type</th><th>Default</th><th>Default request</th><th>Max</th></>} empty={limits.data?.limitRanges.length === 0 ? 'No limit ranges.' : null}>
          {limits.data?.limitRanges.flatMap((l) => l.limits.map((x, i) => (
            <tr key={`${l.name}-${i}`}>
              <td className="mono">{i === 0 ? l.name : ''}</td><td>{x.type}</td>
              <td className="mono">{kv(x.default)}</td><td className="mono">{kv(x.defaultRequest)}</td><td className="mono">{kv(x.max)}</td>
            </tr>
          )))}
        </Table>
      </Section>
    </div>
  );
}

// ── events ──────────────────────────────────────────────────────────────────

export function EventsTab({ ns }: { ns: string }) {
  // Polled, not watched: the Role grants no `watch`, and a 15s poll that pauses
  // in a hidden tab is all a person reading this needs.
  const ev = useKubeRead<EventsResult>('namespace-events', { namespace: ns, limit: 200 }, 15_000);
  const [warnOnly, setWarnOnly] = useState(false);
  const events = (ev.data?.events ?? []).filter((e) => !warnOnly || e.type === 'Warning');
  const warnings = (ev.data?.events ?? []).filter((e) => e.type === 'Warning').length;
  return (
    <div className="cl-stack">
      <ReadHead read={ev} what={`${ev.data?.events.length ?? 0} events, newest first`}>
        <span className="chips">
          <button type="button" className={warnOnly ? '' : 'on'} aria-pressed={!warnOnly} onClick={() => setWarnOnly(false)}>All</button>
          <button type="button" className={warnOnly ? 'on' : ''} aria-pressed={warnOnly} onClick={() => setWarnOnly(true)}>Warnings <span className="n">{warnings}</span></button>
        </span>
      </ReadHead>
      <Stale read={ev} />
      {ev.data && events.length === 0 && <p className="sa-note">{warnOnly ? 'No warnings.' : 'Nothing recent. Events expire after an hour.'}</p>}
      {events.length > 0 && <div className="cl-card"><EventList events={events} /></div>}
    </div>
  );
}

// ── metrics ─────────────────────────────────────────────────────────────────

const RANGE_SECONDS = 3600;
const STEP = 60;

async function podSeries(query: string, signal: AbortSignal): Promise<Series[]> {
  if (import.meta.env.DEV) {
    // The dev server would proxy this to the live box; the stand-in answers in
    // Prometheus' own shape so the page is drawn from the same parser.
    const { promMock } = await import('../../lib/kube-actions.dev');
    const end = Math.floor(Date.now() / 1000);
    const doc = promMock(query, end - RANGE_SECONDS, end, STEP) as { data: { result: { metric: Record<string, string>; values: [number, string][] }[] } };
    return doc.data.result.map((r, i) => ({ key: `${r.metric.pod}-${i}`, label: r.metric.pod, points: r.values.map(([t, v]) => ({ t, v: Number(v) })) }));
  }
  return queryRange(query, { seconds: RANGE_SECONDS, step: STEP, labelKeys: ['pod'], signal });
}

/** The cAdvisor queries. Pod-level only: the kubelet's cAdvisor on this cri-dockerd node leaves `container` empty (monitoring/scrape.d/kubernetes.yml). */
export function clusterQueries(ns: string): { cpu: string; mem: string } {
  const sel = `job="kubelet-cadvisor",cluster="thales-scc",namespace="${ns.replace(/[\\"]/g, '')}",pod!=""`;
  return {
    cpu: `sum by (pod) (rate(container_cpu_usage_seconds_total{${sel}}[5m]))`,
    mem: `sum by (pod) (container_memory_working_set_bytes{${sel}})`,
  };
}

export function MetricsTab({ ns }: { ns: string }) {
  const [state, setState] = useState<{ cpu: Series[]; mem: Series[]; err: string | null; at: number | null }>({ cpu: [], mem: [], err: null, at: null });
  useEffect(() => {
    const ac = new AbortController();
    let timer: ReturnType<typeof setTimeout> | undefined;
    const q = clusterQueries(ns);
    const run = () => {
      Promise.all([podSeries(q.cpu, ac.signal), podSeries(q.mem, ac.signal)]).then(
        ([cpu, mem]) => setState({ cpu, mem, err: null, at: Date.now() }),
        (e) => { if (!ac.signal.aborted) setState((s) => ({ ...s, err: e instanceof Error ? e.message : String(e) })); },
      ).finally(() => { if (!ac.signal.aborted && !document.hidden) timer = setTimeout(run, 30_000); });
    };
    run();
    return () => { ac.abort(); clearTimeout(timer); };
  }, [ns]);

  const pods = [...new Set([...state.cpu, ...state.mem].map((s) => s.label))].sort();
  const cpuOf = (p: string) => state.cpu.find((s) => s.label === p);
  const memOf = (p: string) => state.mem.find((s) => s.label === p);
  const maxCpu = Math.max(0.001, ...state.cpu.flatMap((s) => s.points.map((x) => x.v)));
  const maxMem = Math.max(1, ...state.mem.flatMap((s) => s.points.map((x) => x.v)));

  return (
    <div className="cl-stack">
      <div className="cl-sub">
        <span className="dim cl-fresh">CPU and memory per pod, last hour · kubelet cAdvisor{state.at ? ` · updated ${ago(new Date(state.at).toISOString())}` : ''}</span>
      </div>
      {state.err && <p className="sa-note cl-stale">Metrics are not available right now ({state.err}).{state.at ? ' Showing the last answer.' : ''}</p>}
      {!state.at && !state.err && <p className="sa-working"><span className="sa-spin" />Reading metrics…</p>}
      {state.at && pods.length === 0 && <p className="sa-note">No pod series for {ns}. The kubelet-cadvisor scrape may be down.</p>}
      {pods.length > 0 && (
        <Table label="Pod metrics" head={<><th>Pod</th><th>CPU</th><th className="num">Now</th><th>Memory</th><th className="num">Now</th></>}>
          {pods.map((p) => {
            const c = cpuOf(p);
            const m = memOf(p);
            const cNow = c?.points.at(-1)?.v;
            const mNow = m?.points.at(-1)?.v;
            return (
              <tr key={p}>
                <td className="mono cl-wrap">{p}</td>
                <td><Spark points={c?.points ?? []} max={maxCpu} kind="cpu" label={`CPU of ${p}`} /></td>
                <td className="num mono">{cNow != null ? fmtCores(cNow) : '-'}</td>
                <td><Spark points={m?.points ?? []} max={maxMem} kind="mem" label={`Memory of ${p}`} /></td>
                <td className="num mono">{mNow != null ? fmtSize(mNow) : '-'}</td>
              </tr>
            );
          })}
        </Table>
      )}
    </div>
  );
}

/** A 120×28 sparkline, scaled against the namespace's peak so rows compare. */
function Spark({ points, max, kind, label }: { points: { t: number; v: number }[]; max: number; kind: 'cpu' | 'mem'; label: string }) {
  const W = 120;
  const H = 28;
  if (points.length < 2) return <span className="dim">-</span>;
  const t0 = points[0].t;
  const span = Math.max(1, points[points.length - 1].t - t0);
  const d = points.map((p, i) => `${i ? 'L' : 'M'}${((p.t - t0) / span * W).toFixed(1)},${(H - 2 - (p.v / max) * (H - 4)).toFixed(1)}`).join(' ');
  return (
    <svg className="cl-spark" data-kind={kind} width={W} height={H} viewBox={`0 0 ${W} ${H}`} role="img" aria-label={label}>
      <path d={`${d} L${W},${H} L0,${H} Z`} className="cl-spark-area" />
      <path d={d} className="cl-spark-line" />
    </svg>
  );
}
